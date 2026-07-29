Option Explicit

Const ExpectedArgumentCount = 6
Const TunnelClientPath = "C:\Apps\TunnelClient\tunnel-client.exe"
Const WrapperVersion = "onprem-gh-cli-mcp-wrapper-v3"

Dim arguments
Dim profileName
Dim accountsFile
Dim allowedHosts
Dim auditLogPath
Dim logPath
Dim ghPath
Dim shell
Dim processEnvironment
Dim userEnvironment
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

profileName = arguments.Item(0)
accountsFile = arguments.Item(1)
allowedHosts = arguments.Item(2)
auditLogPath = arguments.Item(3)
logPath = arguments.Item(4)
ghPath = arguments.Item(5)

If Not IsSafeIdentifier(profileName) Then WScript.Quit 2
If Not IsSafeAbsolutePath(accountsFile) Then WScript.Quit 2
If Not IsSafeHostnameCsv(allowedHosts) Then WScript.Quit 2
If Not IsSafeAbsolutePath(auditLogPath) Then WScript.Quit 2
If Not IsSafeAbsolutePath(logPath) Then WScript.Quit 2
If Not IsSafeAbsolutePath(ghPath) Then WScript.Quit 2

Set fileSystem = CreateObject("Scripting.FileSystemObject")
If Not fileSystem.FileExists(TunnelClientPath) Then WScript.Quit 3
If Not fileSystem.FileExists(ghPath) Then WScript.Quit 3
If Not fileSystem.FileExists(accountsFile) Then WScript.Quit 3
If Not fileSystem.FolderExists(fileSystem.GetParentFolderName(auditLogPath)) Then WScript.Quit 3
If Not fileSystem.FolderExists(fileSystem.GetParentFolderName(logPath)) Then WScript.Quit 3

Set shell = CreateObject("WScript.Shell")
Set processEnvironment = shell.Environment("PROCESS")
Set userEnvironment = shell.Environment("USER")

' This wrapper accepts the runtime API key only from the current User's
' persistent environment. A Machine-only value and command-line arguments are
' not accepted.
If Len(userEnvironment("CONTROL_PLANE_API_KEY")) = 0 Then WScript.Quit 4
processEnvironment("CONTROL_PLANE_API_KEY") = userEnvironment("CONTROL_PLANE_API_KEY")

' Account credentials remain in the separate GH_CONFIG_DIR values named by the
' non-secret manifest. Never inherit an ambient token or active-account selector.
RemoveProcessVariable processEnvironment, "GH_TOKEN"
RemoveProcessVariable processEnvironment, "GITHUB_TOKEN"
RemoveProcessVariable processEnvironment, "GH_ENTERPRISE_TOKEN"
RemoveProcessVariable processEnvironment, "GITHUB_ENTERPRISE_TOKEN"
RemoveProcessVariable processEnvironment, "GH_CONFIG_DIR"
RemoveProcessVariable processEnvironment, "GH_HOST"
RemoveProcessVariable processEnvironment, "GH_MCP_EXPECTED_LOGIN"
RemoveProcessVariable processEnvironment, "GH_MCP_ACCOUNT_HOST"
RemoveProcessVariable processEnvironment, "GH_MCP_ALLOWED_HOSTS"
RemoveProcessVariable processEnvironment, "GH_MCP_ALLOWED_OWNERS"
RemoveProcessVariable processEnvironment, "GH_MCP_ALLOWED_REPOSITORIES"

processEnvironment("GH_MCP_ACCOUNTS_FILE") = accountsFile
processEnvironment("GH_MCP_GH_PATH") = ghPath
processEnvironment("GH_MCP_ALLOWED_HOSTS") = allowedHosts
processEnvironment("GH_MCP_AUDIT_LOG_PATH") = auditLogPath

command = QuoteArgument(TunnelClientPath) _
    & " run --profile " & QuoteArgument(profileName) _
    & " --log.file=" & QuoteArgument(logPath)

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function IsSafeIdentifier(value)
    IsSafeIdentifier = Matches(value, "^[A-Za-z0-9_.-]+$")
End Function

Function IsSafeHostnameCsv(value)
    IsSafeHostnameCsv = Matches(value, "^[A-Za-z0-9.-]+(,[A-Za-z0-9.-]+)*$")
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

Sub RemoveProcessVariable(environment, name)
    On Error Resume Next
    environment.Remove name
    On Error GoTo 0
End Sub

Function QuoteArgument(value)
    QuoteArgument = Chr(34) & value & Chr(34)
End Function
