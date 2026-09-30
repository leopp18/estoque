' Sobe o painel de estoque sem janela de console.
' Usado pela tarefa agendada "Painel de Estoque", que roda no logon.
' A janela do iniciar.bat podia ser fechada sem querer e derrubava o site.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "node server.js", 0, False
