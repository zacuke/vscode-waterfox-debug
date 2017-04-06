import { spawn } from 'child_process';
import * as fs from 'fs-extra';

let args = process.argv.splice(2);

let cmd = args.shift();

if (cmd === 'spawnDetached') {

	let exe = args.shift();

	let childProc = spawn(exe!, args, { detached: true, stdio: 'ignore' });

	childProc.unref();

} else if (cmd === 'spawnAndRemove') {

	let pathToRemove = args.shift();
	let exe = args.shift();

	let childProc = spawn(exe!, args);

	childProc.once('exit', () => setTimeout(() => fs.remove(pathToRemove!), 500));

}
