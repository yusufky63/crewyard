; Included by the NSIS installer (electron-builder.config.cjs, nsis.include). PLAN.md section 12.
; Saved as UTF-8 with a byte order mark: without one NSIS reads it in the ANSI code page.
;
; Explorer's "Open in Crewyard" on a folder and on a folder's background. Written per user under
; HKCU\Software\Classes, like the rest of this per-user install, so no admin prompt. Explorer passes
; the folder as "%V"; the app reads it like any other argument (src/main/open-folder.ts), so a drive
; root, a WSL or a network folder gets the same checks and refusals as a typed path.
;
; Windows 11 lists these classic verbs under "Show more options"; the compact menu needs a packaged
; IExplorerCommand, which this installer does not ship.
;
; An update runs the old uninstaller with --updated before the new files land, so the keys are only
; removed on a real uninstall; customInstall writes them again on every install either way.

!macro crewyardWriteVerb ROOT LABEL
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\Crewyard" "" "${LABEL}"
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\Crewyard" "Icon" '"$appExe",0'
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\Crewyard\command" "" '"$appExe" "%V"'
!macroend

!macro customInstall
  Push $0
  ; The verb follows the Windows display language, as the app does on first start: Turkish or English.
  System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
  IntOp $0 $0 & 0x3FF
  ; `=` compares numbers in LogicLib; `==` would compare the text "31" with "0x1F".
  ${if} $0 = 0x1F
    !insertmacro crewyardWriteVerb "Directory" "Crewyard'da aç"
    !insertmacro crewyardWriteVerb "Directory\Background" "Crewyard'da aç"
  ${else}
    !insertmacro crewyardWriteVerb "Directory" "Open in Crewyard"
    !insertmacro crewyardWriteVerb "Directory\Background" "Open in Crewyard"
  ${endIf}
  Pop $0
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\Directory\shell\Crewyard"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Crewyard"
  ${endIf}
!macroend
