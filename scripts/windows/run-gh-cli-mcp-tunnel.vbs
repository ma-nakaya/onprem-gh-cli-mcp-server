Option Explicit

Dim shell
Dim command
Dim exitCode

Set shell = CreateObject("WScript.Shell")

command = """C:\Apps\TunnelClient\tunnel-client.exe""" _
    & " run --profile gh-cli" _
    & " --log.file=""C:\Apps\TunnelClient\gh-cli-tunnel-client.log"""

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
