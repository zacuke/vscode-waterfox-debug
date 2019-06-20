This folder contains the sources for the Firefox debug adapter.

The entry point is the [`FirefoxDebugAdapter`](./firefoxDebugAdapter.ts) class, which receives the
requests from VS Code and delegates most of the work to the [`FirefoxDebugSession`](./firefoxDebugSession.ts) class.

The `firefox` folder contains the implementation of the client for the
[Firefox Remote Debugging Protocol](https://github.com/mozilla/gecko-dev/blob/master/devtools/docs/backend/protocol.md)
and the code for [launching Firefox](./firefox/launch.ts).

The `adapter` folder contains classes that translate between the
[Firefox Remote Debugging Protocol](https://github.com/mozilla/gecko-dev/blob/master/devtools/docs/backend/protocol.md)
and VS Code's [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/).
Furthermore, there is a [class](./adapter/skipFilesManager.ts) for managing skipping (or blackboxing)
files in the debugger and ["coordinator" classes](./adapter/coordinator) that manage the states of
["threads"](https://github.com/mozilla/gecko-dev/blob/master/devtools/docs/backend/protocol.md#interacting-with-thread-like-actors)
in Firefox.
