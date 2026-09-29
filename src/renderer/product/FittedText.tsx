import { useLayoutEffect, useRef } from 'react';
export function FittedText({ children, size, minimumScale = 1 }: {
    children: string;
    size: number;
    minimumScale?: number;
}) {
    const outer = useRef<HTMLSpanElement>(null), inner = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
        const box = outer.current, text = inner.current;
        if (!box || !text)
            return;
        let active = true;
        const fit = () => {
            if (!active || !box.isConnected)
                return;
            text.style.fontSize = `${size}px`;
            const width = text.getBoundingClientRect().width;
            const factor = width ? Math.min(1, Math.max(minimumScale, box.clientWidth / width)) : 1;
            text.style.fontSize = `${size * factor}px`;
        };
        const observer = new ResizeObserver(fit);
        observer.observe(box);
        fit();
        void document.fonts.ready.then(fit);
        return () => { active = false; observer.disconnect(); };
    }, [children, size, minimumScale]);
    return <span ref={outer} style={{ display: 'block', width: '100%', overflow: 'hidden', whiteSpace: 'nowrap' }}>
    <span ref={inner} style={{ display: 'inline-block', fontSize: size }}>{children}</span>
  </span>;
}
