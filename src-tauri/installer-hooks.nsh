; Extra registration Tauri's NSIS template does not do.
;
; Windows will not let an installer silently become the default handler for an
; extension — only a UserChoice written by the user through the shell can do
; that. What an installer *can* do is register the app properly so it shows up
; as a first-class option in "Open with" and in Settings > Default apps.
; Without the Capabilities/RegisteredApplications keys below, the app is
; missing from that Settings list entirely and the user has no obvious way to
; pick it.

; Leave both finish-page boxes ("Create desktop shortcut", "Run SVG
; Viewer") unticked by default. This file is included before the template
; builds its finish page, so these defines reach MUI_PAGE_FINISH.
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!define MUI_FINISHPAGE_RUN_NOTCHECKED

!macro NSIS_HOOK_POSTINSTALL

  ; --- application registration: puts us in the "Open with" list ---
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" \
    "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" \
    "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".svg" ""

  ; --- capabilities: puts us in Settings > Apps > Default apps ---
  WriteRegStr SHCTX "Software\${PRODUCTNAME}\Capabilities" \
    "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\${PRODUCTNAME}\Capabilities" \
    "ApplicationDescription" "Renders SVG files with smooth zoom, backdrop toggles, and live reload."
  WriteRegStr SHCTX "Software\${PRODUCTNAME}\Capabilities\FileAssociations" ".svg" "SVG Image"
  WriteRegStr SHCTX "Software\RegisteredApplications" \
    "${PRODUCTNAME}" "Software\${PRODUCTNAME}\Capabilities"

  ; let the shell notice the new registration without a sign-out
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'

!macroend

!macro NSIS_HOOK_PREUNINSTALL

  ; Clean uninstall by default. The confirm page's box is relabelled "Keep my
  ; settings" (nsis/English.nsh), and Tauri deletes app data when the box state
  ; is 1, so invert it here. Updates (/UPDATE) never delete app data.
  ;
  ; Nor does an upgrade by running a newer installer: its default "uninstall
  ; first" runs this uninstaller without /UPDATE, often passive (/P, no confirm
  ; page, so the box is never seen). The installer runs it in place with _?=,
  ; so $EXEDIR is the install folder; an uninstall the user starts copies
  ; itself to %TEMP% first, so $EXEDIR differs there. StrCmp ignores case.
  ${If} $EXEDIR == $INSTDIR
    StrCpy $DeleteAppDataCheckboxState 0
  ${ElseIf} $UpdateMode <> 1
    ${If} $DeleteAppDataCheckboxState = 1
      StrCpy $DeleteAppDataCheckboxState 0
    ${Else}
      StrCpy $DeleteAppDataCheckboxState 1
    ${EndIf}
  ${EndIf}

  Delete "$DESKTOP\${PRODUCTNAME}.lnk"

  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  DeleteRegKey SHCTX "Software\${PRODUCTNAME}\Capabilities"
  DeleteRegKey /ifempty SHCTX "Software\${PRODUCTNAME}"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'

!macroend
