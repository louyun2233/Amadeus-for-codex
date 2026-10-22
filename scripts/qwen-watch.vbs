Set sh = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
If WScript.Arguments.Count < 2 Then WScript.Quit 2
python = WScript.Arguments(0)
script = WScript.Arguments(1)
If Not fs.FileExists(python) Or Not fs.FileExists(script) Then WScript.Quit 3
sh.CurrentDirectory = fs.GetParentFolderName(script)
command = """" & python & """ """ & script & """ --api --nowebui --no-inbrowser --server-name 127.0.0.1 --server-port 7860 --skip-check"
Function Ready()
  On Error Resume Next
  Dim request
  Set request = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  request.setTimeouts 1000, 1000, 1000, 1000
  request.Open "GET", "http://127.0.0.1:7860/v1/models", False
  request.Send
  Ready = (Err.Number = 0 And request.Status = 200)
  Err.Clear
  On Error GoTo 0
End Function
Do
  If Not Ready() Then sh.Run command, 0, True
  WScript.Sleep 5000
Loop
