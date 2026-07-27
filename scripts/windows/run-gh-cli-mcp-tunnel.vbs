Option Explicit

Const ExpectedArgumentCount = 9
Const TunnelClientPath = "C:\Apps\TunnelClient\tunnel-client.exe"
Const WrapperVersion = "onprem-gh-cli-mcp-wrapper-v2"

Dim arguments
Dim account
Dim profileName
Dim ghConfigDir
Dim allowedOwners
Dim allowedRepositories
Dim auditLogPath
Dim logPath
Dim hostname
Dim ghPath
Dim shell
Dim processEnvironment
Dim fileSystem
Dim command
Dim exitCode

Set arguments = WScript.Arguments
If arguments.Count = 1 Then
    If arguments.Item(0) = "--version" Then
        WScript.StdOut.Write WrapperVersion
        WScript.Quit 0
    End If
End If
If arguments.Count <> ExpectedArgumentCount Then
    WScript.Quit 2
End If

account = arguments.Item(0)
profileName = arguments.Item(1)
ghConfigDir = arguments.Item(2)
allowedOwners = arguments.Item(3)
allowedRepositories = arguments.Item(4)
auditLogPath = arguments.Item(5)
logPath = arguments.Item(6)
hostname = arguments.Item(7)
ghPath = arguments.Item(8)

If Not IsSafeIdentifier(account) Then WScript.Quit 2
If Not IsSafeIdentifier(profileName) Then WScript.Quit 2
If LCase(profileName) <> "gh-cli-" & LCase(account) Then WScript.Quit 2
If Not IsSafeCsv(allowedOwners, False) Then WScript.Quit 2
If Not IsSafeCsv(allowedRepositories, True) Then WScript.Quit 2
If Len(allowedOwners) = 0 And Len(allowedRepositories) = 0 Then WScript.Quit 2
If Not IsSafeHostname(hostname) Then WScript.Quit 2
If Not IsSafeAbsolutePath(ghConfigDir) Then WScript.Quit 2
If Not IsSafeAbsolutePath(auditLogPath) Then WScript.Quit 2
If Not IsSafeAbsolutePath(logPath) Then WScript.Quit 2
If Not IsSafeAbsolutePath(ghPath) Then WScript.Quit 2

Set fileSystem = CreateObject("Scripting.FileSystemObject")
If Not fileSystem.FileExists(TunnelClientPath) Then WScript.Quit 3
If Not fileSystem.FileExists(ghPath) Then WScript.Quit 3
If Not fileSystem.FolderExists(ghConfigDir) Then WScript.Quit 3
If Not fileSystem.FolderExists(fileSystem.GetParentFolderName(logPath)) Then WScript.Quit 3

Set shell = CreateObject("WScript.Shell")
Set processEnvironment = shell.Environment("PROCESS")

' The runtime API key must be inherited from an approved user, machine, or secret-store
' environment. It is intentionally never accepted as a command-line argument.
If Len(processEnvironment("CONTROL_PLANE_API_KEY")) = 0 Then WScript.Quit 4

processEnvironment("GH_CONFIG_DIR") = ghConfigDir
processEnvironment("GH_HOST") = hostname
processEnvironment("GH_MCP_ACCOUNT_HOST") = hostname
processEnvironment("GH_MCP_EXPECTED_LOGIN") = account
processEnvironment("GH_MCP_GH_PATH") = ghPath
processEnvironment("GH_MCP_ALLOWED_HOSTS") = hostname
processEnvironment("GH_MCP_ALLOWED_OWNERS") = allowedOwners
processEnvironment("GH_MCP_ALLOWED_REPOSITORIES") = allowedRepositories
processEnvironment("GH_MCP_AUDIT_LOG_PATH") = auditLogPath

command = QuoteArgument(TunnelClientPath) _
    & " run --profile " & QuoteArgument(profileName) _
    & " --log.file=" & QuoteArgument(logPath)

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function IsSafeIdentifier(value)
    IsSafeIdentifier = Matches(value, "^[A-Za-z0-9_.-]+$")
End Function

Function IsSafeHostname(value)
    IsSafeHostname = Matches(value, "^[A-Za-z0-9.-]+$")
End Function

Function IsSafeCsv(value, repositoryFormat)
    Dim pattern

    If Len(value) = 0 Then
        IsSafeCsv = True
        Exit Function
    End If

    If repositoryFormat Then
        pattern = "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(,[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)*$"
    Else
        pattern = "^[A-Za-z0-9_.-]+(,[A-Za-z0-9_.-]+)*$"
    End If
    IsSafeCsv = Matches(value, pattern)
End Function

Function IsSafeAbsolutePath(value)
    IsSafeAbsolutePath = Matches(value, "^[A-Za-z]:\\[^" & Chr(34) & vbCr & vbLf & "]+$")
End Function

Function Matches(value, pattern)
    Dim expression

    Set expression = New RegExp
    expression.Pattern = pattern
    expression.IgnoreCase = False
    expression.Global = False
    Matches = expression.Test(value)
End Function

Function QuoteArgument(value)
    QuoteArgument = Chr(34) & value & Chr(34)
End Function
