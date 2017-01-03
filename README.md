# VS Code Debug Adapter for Firefox

A Visual Studio Code extension to debug your web application or browser extension in Firefox.

## Starting
You can use this extension in launch or attach mode. 
In launch mode it will start an instance of Firefox navigated to the start page of your application
and terminate it when you stop debugging.
In attach mode it attaches to a running instance of Firefox.

To configure these modes you must create a file `.vscode/launch.json` in the root directory of your
project. You can do so manually or let VS Code create an example configuration for you by clicking 
the gear icon at the top of the Debug pane.
Finally, if `.vscode/launch.json` already exists in your project, you can open it and add a 
configuration snippet to it using the "Add Configuration" button in the lower right corner of the
editor.

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
* `skipFiles`: An array of glob patterns specifying javascript files that should be skipped while
  debugging: the debugger won't break in or step into these files. This is the same as "black boxing"
  scripts in the Firefox Developer Tools. If the URL of a file can't be mapped to a local file path,
  the URL will be matched against these glob patterns, otherwise the local file path will be matched.
  Examples for glob patterns:
  * `"${workspaceRoot}/skipThis.js"` - will skip the file `skipThis.js` in the root folder of your project
  * `"**/skipThis.js"` - will skip files called `skipThis.js` in any folder
  * `"${workspaceRoot}/node_modules/**"` - will skip all files under `node_modules`
  * `"http?(s)://**"` - will skip files that could not be mapped to local files
* `pathMappings`: An array of urls and corresponding paths to use for translating the URLs of
  javascript files to local file paths. Use this if the default mapping of URLs to paths is 
  insufficient in your setup. In particular, if you use [webpack](https://webpack.github.io/), you
  may need to use one of the following mappings:
  ```
  { "url": "webpack:///", "path": "${webRoot}" }
  ```
  or
  ```
  { url": "webpack:///./", "path": "${webRoot}" }
  ```
  or
  ```
  { "url": "webpack:///", "path": "" }
  ```
  To figure out the correct mappings for your project, you can use the `PathConversion` logger
  (see the [Diagnostic logging](#diagnostic-logging) section below) to see all mappings that are
  being used, how URLs are mapped to paths and which URLs couldn't be mapped.
  If you specify more than one mapping, the first mappings in the list will take precedence over 
  subsequent ones and all of them will take precedence over the default mappings.
* `profileDir`, `profile`: You can specify a Firefox profile directory or the name of a profile
  created with the Firefox profile manager. The extension will create a copy of this profile in the
  system's temporary directory and modify the settings in this copy to allow remote debugging.
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

This example will write all messages about conversions from URLs to paths and all error messages
to the VS Code console:
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
