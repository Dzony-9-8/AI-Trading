' watchdog.vbs
' Runs every 5 minutes via Task Scheduler.
' Checks if the bot (node.exe running main.ts) is alive.
' If not, restarts it and sends a Telegram alert.

Dim shell, isRunning
Set shell = CreateObject("WScript.Shell")

' Check if node.exe is running — using WMI (completely silent, no CMD window)
Dim colProcesses
Set colProcesses = GetObject("winmgmts:").ExecQuery("SELECT * FROM Win32_Process WHERE Name='node.exe'")
isRunning = (colProcesses.Count > 0)

If Not isRunning Then
    ' Bot is not running — restart it
    shell.Run "cmd /c ""D:\AI\AI Trading\start.bat""", 7, False

    ' Read Telegram credentials from .env and send alert
    Dim fso, file, line, token, chatId
    Set fso = CreateObject("Scripting.FileSystemObject")
    If fso.FileExists("D:\AI\AI Trading\.env") Then
        Set file = fso.OpenTextFile("D:\AI\AI Trading\.env", 1)
        Do While Not file.AtEndOfStream
            line = file.ReadLine()
            If Left(line, 21) = "TELEGRAM_BOT_TOKEN=" Then
                token = Mid(line, 22)
            End If
            If Left(line, 17) = "TELEGRAM_CHAT_ID=" Then
                chatId = Mid(line, 18)
            End If
        Loop
        file.Close
    End If

    If token <> "" And chatId <> "" Then
        Dim http
        Set http = CreateObject("MSXML2.XMLHTTP")
        Dim url, body
        url = "https://api.telegram.org/bot" & token & "/sendMessage"
        body = "{""chat_id"":""" & chatId & """,""text"":""\u26a0\ufe0f LocalTrader crashed and was restarted automatically by watchdog."",""parse_mode"":""HTML""}"
        http.Open "POST", url, False
        http.setRequestHeader "Content-Type", "application/json"
        http.Send body
    End If
End If

Set shell = Nothing
