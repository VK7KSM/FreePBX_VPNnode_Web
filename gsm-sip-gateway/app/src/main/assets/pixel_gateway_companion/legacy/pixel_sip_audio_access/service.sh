#!/system/bin/sh

PACKAGE=org.onetwoone.gateway
AUDIO_GID=1005
MODDIR=${0%/*}
MAGISKPOLICY=/data/adb/magisk/magiskpolicy

# Reapply once in the late-start stage in case early policy loading raced Magisk startup.
if [ ! -x "$MAGISKPOLICY" ]; then
    MAGISKPOLICY=$(command -v magiskpolicy)
fi
if [ -n "$MAGISKPOLICY" ] && [ -f "$MODDIR/sepolicy.rule" ]; then
    "$MAGISKPOLICY" --live --apply "$MODDIR/sepolicy.rule"
fi

for attempt in $(seq 1 60); do
    APP_UID=$(dumpsys package "$PACKAGE" 2>/dev/null |
        sed -n 's/.*userId=\([0-9][0-9]*\).*/\1/p' | head -n 1)
    APP_CONTEXT=$(ls -Zd "/data/user_de/0/$PACKAGE" 2>/dev/null | awk '{print $1}')
    APP_LEVEL=${APP_CONTEXT#u:object_r:app_data_file:}
    if [ -n "$APP_UID" ] && [ -e /dev/snd/controlC0 ] &&
        [ "$APP_LEVEL" != "$APP_CONTEXT" ] &&
        [ -e /dev/snd/pcmC0D0c ] && [ -e /dev/snd/pcmC0D27p ]; then
        chown "$APP_UID:$AUDIO_GID" \
            /dev/snd/controlC0 /dev/snd/pcmC0D0c /dev/snd/pcmC0D27p
        chmod 0660 \
            /dev/snd/controlC0 /dev/snd/pcmC0D0c /dev/snd/pcmC0D27p
        chcon "u:object_r:audio_device:$APP_LEVEL" \
            /dev/snd/controlC0 /dev/snd/pcmC0D0c /dev/snd/pcmC0D27p
        exit 0
    fi
    sleep 2
done

exit 1
