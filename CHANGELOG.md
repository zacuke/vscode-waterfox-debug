### Version 0.9.1
* fix `reAttach` on Windows

### Version 0.9.0
* Add `reAttach` and `reloadOnAttach` configuration properties

### Version 0.8.8
* bugfix: source files were not mapped to local files in VS Code 1.9

### Version 0.8.7
* workaround for Firefox sending inaccurate source information in certain situations, which can break the `skipFiles` feature

### Version 0.8.6
* bugfix: some URLs were not handled correctly when processing sourcemapped sources

### Version 0.8.5
* send log messages from add-ons to the debug console

### Version 0.8.4
* bugfix: exceptions were not shown

### Version 0.8.3
* strip query strings from urls when converting them to local file paths

### Version 0.8.2
* fix skipFiles on Windows

### Version 0.8.1
* bugfix: sources could not be skipped during their first execution

### Version 0.8.0
* Add `skipFiles` configuration property
* Add `pathMappings` configuration property
* Add configuration snippets
* Fix several bugs when evaluating watches and expressions entered in the debug console

### Version 0.7.7
* fix debugging of WebExtension content scripts in recent Firefox builds

### Version 0.7.6
* bugfix: breakpoints were sometimes not hit after a page reload

### Version 0.7.5
* bugfix: support javascript values of type Symbol
* bugfix: evaluating expressions in the VS Code debug console sometimes stopped working

### Version 0.7.2
* Terminate the debug session when Firefox is closed

### Version 0.7.1
* Show the full url of sources that do not correspond to local files
* bugfix for setting breakpoints in content scripts of `addonSdk` browser extensions

### Version 0.7.0
* Debugging Firefox add-ons
* Launch mode now always creates a temporary profile: if a profile is specified in the launch
  configuration, it will be copied and modified to allow remote debugging
* Launch mode now uses the developer edition of Firefox if it is found

### Version 0.6.5
* bugfix for sourcemaps with embedded source files

### Version 0.6.4
* Fix breakpoint handling when a Firefox tab is reloaded
* Only send javascript-related warnings and errors from Firefox to the debug console

### Version 0.6.3
* Add configuration option for diagnostic logging
* Make conversion between paths and urls more robust

### Version 0.6.2
* bugfix: stepping and resuming stopped working if a breakpoint was hit immediately after loading the page

### Version 0.6.1
* Fix debugging WebWorkers and multiple browser tabs in VSCode 1.2.0

### Version 0.6.0
* Add support for evaluating javascript expressions in the debug console even if Firefox isn't paused
* Add support for debugger statements

### Version 0.5.0
* Add support for call stack paging

### Version 0.4.0
* Add support for debugging WebWorkers
* Add support for debugging multiple browser tabs
* Fix exception breakpoints in VSCode 1.1.0
* Re-create the Firefox profile on every launch, unless a profile name or directory is configured

### Version 0.3.0
* Print messages from the Firefox console in the VS Code debug console
* bugfix: resume the VS Code debugger when Firefox resumes, e.g. if the user reloads the page in 
  Firefox while the debugger is paused

### Version 0.2.0
* Automatically create a Firefox profile for debugging

### Version 0.1.0
* Initial release
