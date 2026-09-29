using System.Security.Cryptography;

internal delegate void Pcm16FrameSink(ReadOnlySpan<byte> bytes);

// Single-owner converter: the caller serializes Append, Finish, and Dispose.
// Linear interpolation and channel downmix use rational sample positions
// and retain only one preceding sample between input frames.
internal sealed class Pcm16Converter(int sampleRate, int channels, Pcm16FrameSink emit) : IDisposable
{
    internal const int OutputRate = 16_000, FrameBytes = 3_200, MaximumSamples = 4_800_000;
    private readonly byte[] pending = new byte[FrameBytes];
    private long inputFrames;
    private float previous;
    private int pendingBytes;
    private bool finished;
    internal int TotalSamples { get; private set; }
    internal bool LimitReached => TotalSamples == MaximumSamples;

    internal void Append(ReadOnlySpan<float> samples, int actualRate, int actualChannels)
    {
        if (finished) throw new CommandFailure("AUDIO_INVALID_STATE");
        if (sampleRate is < 16_000 or > 192_000 || channels is < 1 or > 32
            || actualRate != sampleRate || actualChannels != channels || samples.Length % channels != 0
            || samples.Length / channels > sampleRate / 10)
            throw new CommandFailure("AUDIO_FORMAT_UNSUPPORTED");

        for (int offset = 0; offset < samples.Length && !LimitReached; offset += channels)
        {
            double sum = 0;
            for (int channel = 0; channel < channels; channel++)
            {
                float value = samples[offset + channel];
                sum += float.IsFinite(value) ? Math.Clamp(value, -1f, 1f) : 0f;
            }
            float current = (float)(sum / channels);
            long position = (long)TotalSamples * sampleRate;
            long currentPosition = inputFrames * OutputRate;
            if (position <= currentPosition)
            {
                double fraction = inputFrames == 0 ? 1 : (double)(position - (inputFrames - 1) * OutputRate) / OutputRate;
                WriteSample((float)(previous + (current - previous) * fraction));
            }
            previous = current;
            inputFrames++;
        }
    }

    private void WriteSample(float sample)
    {
        int scaled = sample switch
        {
            <= -1 => short.MinValue,
            >= 1 => short.MaxValue,
            _ => (int)MathF.Round(sample * 32768f, MidpointRounding.AwayFromZero),
        };
        short value = (short)Math.Clamp(scaled, short.MinValue, short.MaxValue);
        pending[pendingBytes++] = unchecked((byte)value);
        pending[pendingBytes++] = unchecked((byte)(value >> 8));
        TotalSamples++;
        if (pendingBytes == FrameBytes) EmitPending();
    }

    private void EmitPending()
    {
        // The sink checks capacity before copying. Overflow cannot allocate a
        // 21st queued frame in addition to the single assembly buffer.
        try { emit(pending.AsSpan(0, pendingBytes)); }
        finally
        {
            CryptographicOperations.ZeroMemory(pending);
            pendingBytes = 0;
        }
    }

    internal void Finish()
    {
        if (finished) return;
        finished = true;
        // A fractional final position needs a following input sample. Do not
        // synthesize extrapolated audio; flush only real converted samples.
        previous = 0;
        if (pendingBytes != 0) EmitPending();
    }

    public void Dispose()
    {
        finished = true;
        previous = 0;
        pendingBytes = 0;
        CryptographicOperations.ZeroMemory(pending);
    }
}
