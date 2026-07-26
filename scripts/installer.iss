; Traces: BASED-INSTALLER-WIN, BASED-SQL-ASSOC-WIN
; Windows installer for based. Built by scripts/package-win.ps1, which passes:
;   /DAppVersion=<version from shell/electrobun.config.ts>
;   /DBundleDir=<electrobun stable bundle dir, already containing bin\based-open.exe + icon.ico>
;   /DOutputDir=<repo dist\>
; Per-user install (no UAC), Start Menu shortcut, Apps & Features uninstall entry, and HKCU
; registration of based as an *available* handler for .sql (Open With + Default Apps) — the
; user's existing .sql default is never overwritten.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef BundleDir
  #error Pass /DBundleDir=<stable bundle dir>
#endif
#ifndef OutputDir
  #define OutputDir "..\dist"
#endif

#define AppName "based"
#define ProgId "based.sql"

[Setup]
AppId={{7E1B62D3-4C60-4E2A-9E01-BA5ED1C60A2F}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Cyrus Attoun
AppPublisherURL=https://github.com/Cyronius/based
AppSupportURL=https://github.com/Cyronius/based/issues
AppUpdatesURL=https://github.com/Cyronius/based/releases
DefaultDirName={localappdata}\Programs\{#AppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename={#AppName}-{#AppVersion}-Setup
SetupIconFile={#BundleDir}\icon.ico
UninstallDisplayIcon={app}\icon.ico
ChangesAssociations=yes
Compression=lzma2
SolidCompression=yes
CloseApplications=yes
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "{#BundleDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\bin\launcher.exe"; IconFilename: "{app}\icon.ico"; WorkingDir: "{app}\bin"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\bin\launcher.exe"; IconFilename: "{app}\icon.ico"; WorkingDir: "{app}\bin"; Tasks: desktopicon

[Registry]
; ProgID: what "opening a .sql with based" means. The open verb routes through based-open.exe
; because electrobun's launcher.exe drops argv (see scripts/win/based-open.cs).
Root: HKCU; Subkey: "Software\Classes\{#ProgId}"; ValueType: string; ValueData: "SQL file"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\{#ProgId}\DefaultIcon"; ValueType: string; ValueData: "{app}\icon.ico"
Root: HKCU; Subkey: "Software\Classes\{#ProgId}\shell\open\command"; ValueType: string; ValueData: """{app}\bin\based-open.exe"" ""%1"""
; Add based to .sql's Open With list WITHOUT touching the extension's default handler. Only our
; value is removed on uninstall — the .sql key belongs to the system/other apps.
Root: HKCU; Subkey: "Software\Classes\.sql\OpenWithProgids"; ValueType: string; ValueName: "{#ProgId}"; ValueData: ""; Flags: uninsdeletevalue
; Default Programs registration so based shows up in Settings → Default apps for .sql.
Root: HKCU; Subkey: "Software\{#AppName}\Capabilities"; ValueType: string; ValueName: "ApplicationName"; ValueData: "{#AppName}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\{#AppName}\Capabilities"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "SQL client"
Root: HKCU; Subkey: "Software\{#AppName}\Capabilities\FileAssociations"; ValueType: string; ValueName: ".sql"; ValueData: "{#ProgId}"
Root: HKCU; Subkey: "Software\RegisteredApplications"; ValueType: string; ValueName: "{#AppName}"; ValueData: "Software\{#AppName}\Capabilities"; Flags: uninsdeletevalue

[Run]
Filename: "{app}\bin\launcher.exe"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent; WorkingDir: "{app}\bin"

[UninstallDelete]
; The app writes logs beside its binaries (bin\app.log); sweep the install dir so uninstall
; leaves nothing. User data (app.db, agent.db, secrets) lives in %APPDATA%\based — untouched.
Type: filesandordirs; Name: "{app}"
