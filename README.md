Waterfox conversion steps:
* Case sensitive Search and replace
  * `Firefox` to `Waterfox`
  * `firefox` to `waterfox`
* Rollback the docs
  * `git restore '*.md'`
* Rename folder and files
  * `./src/adapter/firefox` to `./src/adapter/waterfox`
  * `./src/adapter/firefoxDebugAdapter.ts` to `./src/adapter/waterfoxDebugAdapter.ts`
  * `./src/adapter/firefoxDebugSession.ts` to `./src/adapter/waterfoxDebugSession.ts`
* Fix Windows path (Remove `Mozilla `) In `./src/adapter/configuration.ts`
  * `C:\\Program Files\\Mozilla Waterfox\\waterfox.exe` to `C:\\Program Files\\Waterfox\\waterfox.exe`
  *	`C:\\Program Files (x86)\\Mozilla Waterfox\\waterfox.exe` to `C:\\Program Files (x86)\\Waterfox\\waterfox.exe`
* Fix `package.json`
  * Line 5 - author
  * Line 17 - add --glob
  * Line 39 - waterfox-profile version
  * Line 117 - repo
  * Line 127 - bugs
  * Line 130 - homepage
* Add `dist/*LICENSE.txt` to .gitignore
* Replace icon.png
* Update README.md below


<h1 align="center">
  <br>
    <img src="https://github.com/zacuke/vscode-waterfox-debug/blob/master/icon.png?raw=true" alt="logo" width="200">
  <br>
  VS Code Debugger for Waterfox
  <br>
  <br>
</h1>

<h4 align="center">Debug your JavaScript code running in Waterfox from VS Code.</h4>

<h4 align="center">Forked from https://github.com/firefox-devtools/vscode-firefox-debug</h4>