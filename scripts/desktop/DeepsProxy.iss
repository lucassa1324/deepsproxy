; DeepsProxy.iss — script do instalador (Inno Setup 6).
; Compila com:  ISCC.exe /DMyAppVersion=x.y.z DeepsProxy.iss
; O conteúdo vem de: ..\..\release\DeepsProxy\

#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif

#define MyAppName "DeepsProxy"
#define MyAppPublisher "Lucas Sá"
#define MyAppExeName "DeepsProxy.exe"
#define MyAppId "8F3CF0C1-0B2E-4A6F-9C11-DE45E9276B55"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\DeepsProxy
DefaultGroupName=DeepsProxy
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\..\release
OutputBaseFilename=DeepsProxy-Setup-{#MyAppVersion}
SetupIconFile=..\..\release\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
AppMutex=Local\DeepsProxy.DeepsProxy.SingleInstance

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na &area de trabalho"; GroupDescription: "Atalhos:"
Name: "autostart"; Description: "&Iniciar o DeepsProxy junto com o Windows"; GroupDescription: "Atalhos:"

[Files]
Source: "..\..\release\DeepsProxy\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
; Início automático (opcional, via HKCU — sem admin).
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "DeepsProxy"; ValueData: """{app}\{#MyAppExeName}"""; Tasks: autostart

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Iniciar o {#MyAppName} agora"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\deepseek_profile"
Type: filesandordirs; Name: "{app}\qwen_profile"
Type: filesandordirs; Name: "{app}\gemini_profile"
Type: filesandordirs; Name: "{app}\browsers"
Type: filesandordirs; Name: "{app}\node_modules"
Type: files; Name: "{app}\server.log"
Type: files; Name: "{app}\providers.json"
Type: files; Name: "{app}\gateway-apps.json"
Type: files; Name: "{app}\gateway-economy.json"
Type: files; Name: "{app}\gateway-booster.json"