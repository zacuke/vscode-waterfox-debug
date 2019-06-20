This folder contains the sources for the Debug Adapter for Firefox extension.
They are grouped into the following subfolders:

* `adapter` -
  the [debug adapter](https://code.visualstudio.com/api/extension-guides/debugger-extension#debugging-architecture-of-vs-code)
  itself, which is run in a separate process and talks to VS Code using the
  [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)

* `extension` - contains additional integration with VS Code (this code will be run in the VS Code extension host):
  * the Loaded Scripts Explorer, which is shown at the bottom of the debug view
  * a [DebugConfigurationProvider](https://code.visualstudio.com/api/extension-guides/debugger-extension#using-a-debugconfigurationprovider)
    that adds [machine-specific configuration](https://github.com/hbenl/vscode-firefox-debug#overriding-configuration-properties-in-your-settings)
    (like the location of the Firefox executable, the name of the profile to use for debugging, etc.)
    from the user's VS Code settings to debug configurations
  * a button to toggle the “Disable Popup Auto-Hide” flag (for WebExtension debugging) from VS Code

* `test` - mocha tests for this extension

* `common` - a few interfaces and functions used throughout this extension

* `typings` - type definition files for npm modules for which no type definitions exist on npm
