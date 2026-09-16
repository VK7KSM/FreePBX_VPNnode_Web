#!/system/bin/sh
# Reversible system-app debloat for the unattended SIP/SMS gateway.
# Restore a package with: cmd package install-existing --user 0 <package>

packages='\
com.google.android.youtube
com.google.android.gm
com.google.android.apps.docs
com.google.android.apps.maps
com.google.android.apps.photos
com.google.android.apps.tips
com.google.android.music
com.google.android.videos
com.google.android.googlequicksearchbox
com.google.android.apps.wellbeing
com.google.android.feedback
com.google.android.apps.internal.betterbug
com.google.android.printservice.recommendation
com.android.printspooler
com.google.android.projection.gearhead
com.google.android.apps.wearables.maestro.companion
com.google.vr.vrcore
com.google.vr.apps.ornament
com.google.ar.core
com.google.android.accessibility.soundamplifier
com.google.android.marvin.talkback
com.google.android.apps.customization.pixel
com.google.android.apps.wallpaper
com.google.android.apps.wallpaper.nexus
com.google.android.apps.diagnosticstool
com.google.android.apps.carrier.log
com.google.android.apps.dreamliner
com.google.android.dreamlinerupdater'

for package in $packages; do
  if pm path "$package" >/dev/null 2>&1; then
    printf 'Disabling %s: ' "$package"
    pm disable-user --user 0 "$package"
  fi
done
