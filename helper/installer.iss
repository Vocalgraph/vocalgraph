; Inno Setup script for the Vocalgraph Helper (Windows). Build it after
; PyInstaller, from the repo root (see helper/build.ps1):
;   ISCC.exe helper\installer.iss
; Per-user: installs to %LOCALAPPDATA%\Programs\Vocalgraph Helper without
; asking for administrator rights, and registers the vocalgraph:// link for
; this user only. The version is read from the built exe, whose file version
; PyInstaller took from VERSION in vocalgraph/helper.py.

#define AppName "Vocalgraph Helper"
#define AppExe "Vocalgraph Helper.exe"
#define BuildDir AddBackslash(SourcePath) + "dist\" + AppName
#if !FileExists(BuildDir + "\" + AppExe)
  #error Build the exe with PyInstaller first (helper\dist\Vocalgraph Helper\Vocalgraph Helper.exe is missing).
#endif
#define AppVersion GetStringFileInfo(BuildDir + "\" + AppExe, "ProductVersion")

[Setup]
; A fixed id: upgrades replace the install instead of adding a second one.
AppId={{6C9F2B7E-3E4D-4F7A-9C1B-5A8E2D0F4B61}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Vocalgraph
AppPublisherURL=https://github.com/Vocalgraph/vocalgraph
AppSupportURL=https://github.com/Vocalgraph/vocalgraph/tree/main/helper
VersionInfoVersion={#AppVersion}
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\{#AppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
DefaultGroupName={#AppName}
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
; Relative to this script's folder: helper\Output.
OutputDir=Output
OutputBaseFilename=VocalgraphHelperSetup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
; The helper is asked to quit first (below); this catches anything still
; holding its files.
CloseApplications=yes
RestartApplications=no

[Tasks]
Name: "startmenu"; Description: "Add {#AppName} to the Start menu"; Flags: unchecked

[Files]
Source: "{#BuildDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; An upgrade replaces the whole bundled Python, not just the files it overwrites.
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
Name: "{userprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: startmenu

[Registry]
; The vocalgraph:// link, for this user only. It runs the helper with the
; link's text after --from-link, which the helper ignores.
Root: HKCU; Subkey: "Software\Classes\vocalgraph"; ValueType: string; ValueName: ""; ValueData: "URL:Vocalgraph Helper"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\vocalgraph"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\vocalgraph\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExe}"",0"
Root: HKCU; Subkey: "Software\Classes\vocalgraph\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExe}"" --from-link ""%1"""

[Run]
; Started when the installer finishes (a ticked box on its last page), so
; the Vocalgraph page that offered the download finds it straight away.
Filename: "{app}\{#AppExe}"; Description: "Start {#AppName} now"; Flags: nowait postinstall

[UninstallRun]
Filename: "{app}\{#AppExe}"; Parameters: "--quit"; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId: "QuitHelper"

[UninstallDelete]
; Its log (and the older one), kept outside the install folder.
Type: filesandordirs; Name: "{localappdata}\{#AppName}"

[Code]
// Before an upgrade: ask the helper that's installed now to quit, so its files can be replaced.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Exe: String;
  Code: Integer;
begin
  Result := '';
  Exe := ExpandConstant('{app}\{#AppExe}');
  if FileExists(Exe) then
    Exec(Exe, '--quit', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;
