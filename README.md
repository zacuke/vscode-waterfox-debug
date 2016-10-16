# VS Code Debug Adapter for Firefox

A Visual Studio Code extension to debug your web application in Firefox.

## Features
* Line breakpoints
* Conditional breakpoints
* Exception breakpoints (caught and uncaught)
* Breaking on `debugger` statements
* Step over, step in, step out
* Stepping into scripts passed to eval()
* Inspecting stackframes, object properties (including prototypes) and return values
* Watches
* Evaluating javascript expressions in the debug console of VS Code
* Sourcemaps - these are handled by Firefox, so if they work in the built-in Firefox debugger,
  they should also work in VS Code
* Debugging WebWorkers
* Debugging multiple browser tabs
* Debugging Firefox add-ons

## Starting
You can use this extension in launch or attach mode. 
In launch mode it will start an instance of Firefox navigated to the start page of your application
and terminate it when you stop debugging.
In attach mode it attaches to a running instance of Firefox.

To configure these modes you must create a file `.vscode/launch.json` in the root directory of your
project. You can do so manually or let VS Code create an example configuration for you by clicking 
the gear icon at the top of the Debug pane.

### Launch
Here's an example configuration for launching Firefox navigated to the local file `index.html` 
in the root directory of your project:
```
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Launch index.html",
            "type": "firefox",
            "request": "launch",
            "file": "${workspaceRoot}/index.html"
        }
    ]
}
```

You may want (or need) to debug your application running on a Webserver (especially if it interacts
with server-side components like Webservices). In this case replace the `file` property in your
`launch` configuration with a `url` and a `webRoot` property. These properties are used to map
urls to local files:
```
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Launch localhost",
            "type": "firefox",
            "request": "launch",
            "url": "http://localhost/index.html",
			"webRoot": "${workspaceRoot}"
        }
    ]
}
```
The `url` property may point to a file or a directory, if it points to a directory it must end with
a trailing `/` (e.g. `http://localhost/my-app/`).

### Attach
To use attach mode, you have to launch Firefox manually from a terminal with remote debugging enabled.
Note that you must first configure Firefox to allow remote debugging. To do this, open the Firefox 
configuration page by entering `about:config` in the address bar. Then set the following preferences:

Preference Name                       | Value   | Comment
--------------------------------------|---------|---------
`devtools.debugger.remote-enabled`    | `true`  | Required
`devtools.chrome.enabled`             | `true`  | Required
`devtools.debugger.workers`           | `true`  | Required if you want to debug WebWorkers
`devtools.debugger.prompt-connection` | `false` | Recommended
`devtools.debugger.force-local`       | `false` | Set this only if you want to attach VS Code to Firefox running on a different machine (using the `host` property in the `attach` configuration)

Then close Firefox and start it from a terminal like this:

__Windows__

`"C:\Program Files\Mozilla Firefox\firefox.exe" -start-debugger-server -no-remote`

__OS X__

`/Applications/Firefox.app/Contents/MacOS/firefox -start-debugger-server -no-remote`

__Linux__

`firefox -start-debugger-server -no-remote`

Navigate to your web application and use this `launch.json` configuration to attach to Firefox:
```
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Launch index.html",
            "type": "firefox",
            "request": "attach"
        }
    ]
}
```

If your application is running on a Webserver, you need to add the `url` and `webRoot` properties
to the configuration (as in the second `launch` configuration example above).

### Debugging Firefox add-ons
If you want to debug a Firefox add-on, you have to install the developer edition of Firefox. In
launch mode, it will automatically be used if it is installed in the default location.
If your add-on is developed with the add-on SDK, you also have to ensure that the `jpm` command
is in the system path.

Here's an example configuration for add-on debugging:
```
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Launch addon",
            "type": "firefox",
            "request": "launch",
            "addonType": "addonSdk",
            "addonPath": "${workspaceRoot}"
        }
    ]
}
```
The `addonType` property must be set to `addonSdk`, `webExtension` or `legacy`, depending on the
type of your add-on. The `addonPath` must be the absolute path to the directory containing the
add-on manifest (`package.json` for `addonSdk` add-ons, `manifest.json` for `webExtension` add-ons
or `install.rdf` for `legacy` add-ons).

### Optional configuration properties
* `profileDir`, `profile`: You can specify a Firefox profile directory or the name of a profile
  created with the Firefox profile manager. The extension will create a copy of this profile in the
  system's temporary directory and modify the settings in this copy to allow remote debugging.
  If you specify a profile directory which doesn't exist yet, it will be created and
  configured for remote debugging automatically.
* `port`: Firefox uses port 6000 for the debugger protocol by default. If you want to use a different
  port, you can set it with this property.
* `firefoxExecutable`: The absolute path to the Firefox executable (`launch` configuration only).
  If not specified, this extension will use the default Firefox installation path. It will look for
  both regular and developer editions of Firefox; if both are available, it will use the developer
  edition.
* `firefoxArgs`: An array of additional arguments used when launching Firefox (`launch` configuration only)
* `host`: If you want to debug with Firefox running on different machine, you can specify the 
  device's address using this property (`attach` configuration only).
* `log`: Configures diagnostic logging for this extension. This may be useful for troubleshooting
  (see below for examples).

### Diagnostic logging
The following example for the `log` property will write all log messages to the file `log.txt` in
your workspace:
```
...
    "log": {
        "fileName": "${workspaceRoot}/log.txt",
        "fileLevel": {
            "default": "Debug"
        }
    }
...
```

This example will write all messages about conversions between paths and urls and all error messages
to the VSCode console:
```
...
    "log": {
        "consoleLevel": {
            "PathConversion": "Debug",
            "default": "Error"
        }
    }
...
```
 
## Troubleshooting
* Breakpoints that should get hit immediately after the javascript file is loaded may not work the
  first time: You will have to click "Reload" in Firefox for the debugger to stop at such a
  breakpoint. This is a weakness of the Firefox debug protocol: VSCode can't tell Firefox about
  breakpoints in a file before the execution of that file starts.
* If your breakpoints remain unverified after launching the debugger (i.e. they appear gray instead
  of red), the conversion between file paths and urls may not work. The messages from the 
  `PathConversion` logger may contain clues how to fix your configuration. Have a look at the 
  "Diagnostic Logging" section for an example how to enable this logger.
* If you think you've found a bug in this adapter please [file a bug report](https://github.com/hbenl/vscode-firefox-debug/issues).
  It may be helpful if you create a log file (as described in the "Diagnostic Logging" section) and
  attach it to the bug report.

## Changelog

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
 
