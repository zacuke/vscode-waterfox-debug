import { spawn } from 'child_process';

let args = process.argv;
args.shift();
args.shift();
let exe = args.shift();

let childProc = spawn(exe!, args, { detached: true, stdio: 'ignore' });

childProc.unref();
