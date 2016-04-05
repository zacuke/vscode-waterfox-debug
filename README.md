# VS Code Debug Adapter for Firefox

A Visual Studio Code extension to debug your web application in Firefox.

## Features
* Line breakpoints
* Conditional breakpoints
* Exception breakpoints (caught and uncaught)
* Step over, step in, step out
* Stepping into scripts passed to eval()
* Inspecting stackframes, object properties (including prototypes) and return values
* Watches
* Evaluating javascript expressions in the debug console of VS Code
* Sourcemaps - these are handled by Firefox, so if they work in the built-in Firefox debugger,
  they should also work in VS Code

## Setup
Before you can use this extension you must setup Firefox to allow remote debugging connections.
It is recommended (although not required) that you do this in a separate Firefox profile.

### Creating a profile
Close all Firefox windows and then launch the Firefox Profile Manager from a terminal:

__Windows__

`"C:\Program Files\Mozilla Firefox\firefox.exe" -ProfileManager`

__OS X__

`/Applications/Firefox.app/Contents/MacOS/firefox -ProfileManager`

__Linux__

`firefox -ProfileManager`

Click "Create profile..." and enter a name for the new profile (e.g. `debug`).
Back in the Profile Manager select the profile you just created, uncheck the checkbox labeled 
"Use the selected profile without asking at startup" and click "Start Firefox".
Then configure Firefox for remote debugging as described below.

Note that the next time you start Firefox, the Profile Manager will be started again. Select the
default profile and check the checkbox labeled "Use the selected profile without asking at startup"
so that the default profile will be used automatically again (VS Code will keep using the profile
you specify in the launch configuration).

### Configuring Firefox for remote debugging
Open the configuration page for the current Firefox profile by entering `about:config` in 
the address bar. Then set the following preferences:

Preference Name                       | Value   | Comment
--------------------------------------|---------|---------
`devtools.debugger.remote-enabled`    | `true`  | Required
`devtools.chrome.enabled`             | `true`  | Required
`devtools.debugger.prompt-connection` | `false` | Recommended
`devtools.debugger.force-local`       | `false` | Set this only if you want to attach VS Code to Firefox running on a different machine

## Starting
You can use this extension in launch or attach mode. 
In launch mode it will start an instance of Firefox navigated to the start page of your application
and terminate it when you stop debugging.
In attach mode it attaches to a running instance of Firefox.

To configure these modes you must create a file `.vscode/launch.json` in the root directory of your
project. You can do so manually or let VS Code create an example configuration for you by clicking 
the gear icon at the top of the Debug pane.

### Launch
Here's an example configuration for launching Firefox (using the `debug` profile created above)
navigated to the local file `index.html` in the root directory of your project:
```
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Launch index.html",
            "type": "firefox",
            "request": "launch",
            "profile": "debug",
            "file": "${workspaceRoot}/index.html"
        }
    ]
}
```

You may want (or need) to debug your application running on a Webserver (especially if it interacts
with server-side components like Webservices). In this case replace the `file` property in your
launch configuration with a `url` and a `webRoot` property. These properties are used to map
urls to local files:
```
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Launch localhost",
            "type": "firefox",
            "request": "launch",
            "profile": "debug",
            "url": "http://localhost/index.html",
			"webRoot": "${workspaceRoot}"
        }
    ]
}
```

### Attach
You must manually launch Firefox from a terminal with remote debugging enabled.
Here's an example for each platform (using the `debug` profile created above):

__Windows__

`"C:\Program Files\Mozilla Firefox\firefox.exe" -P debug -start-debugger-server -no-remote`

__OS X__

`/Applications/Firefox.app/Contents/MacOS/firefox -P debug -start-debugger-server -no-remote`

__Linux__

`firefox -P debug -start-debugger-server -no-remote`

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
to the configuration (as in the second launch configuration example above).

### Optional configuration properties
* `profile`: If you don't want to use a separate Firefox profile for debugging, you can remove this
  property from your configuration
* `port`: Firefox uses port 6000 for the debugger protocol by default. If you want to use a different
  port, you can set it with this property
* `firefoxExecutable`: The absolute path to the Firefox executable (`launch` configuration only). If 
  not specified, this extension will use the default installation path
* `firefoxArgs`: An array of additional arguments used when launching Firefox (`launch` configuration only)
* `host`: If you want to debug with Firefox running on different machine, you can specify the 
  device's address using this property (`attach` configuration only)

## Troubleshooting
* Sometimes when using a `launch` configuration you may get a message saying that Firefox was
  closed unexpectedly. If this happens, click "Start in Safe Mode" and then close Firefox manually.
  Afterwards, you should be able to launch it again.
  This is due to [Firefox bug #336193](https://bugzilla.mozilla.org/show_bug.cgi?id=336193).

