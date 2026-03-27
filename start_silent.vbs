' start_silent.vbs
' Launches the LocalTrader bot minimized to the taskbar.
' Called by Task Scheduler at logon — no CMD window popup.

Dim shell
Set shell = CreateObject("WScript.Shell")

' Change to the project directory and launch the bot
' The window style 7 = minimised, not stealing focus
shell.Run "cmd /c ""D:\AI\AI Trading\start.bat""", 7, False

Set shell = Nothing
