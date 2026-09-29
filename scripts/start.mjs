import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
const root=fileURLToPath(new URL('../',import.meta.url));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require('electron'),[root],{cwd:root,env,stdio:'inherit',shell:false});
child.on('error',()=>{process.stderr.write('Unable to launch the Electron runtime.\n');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
