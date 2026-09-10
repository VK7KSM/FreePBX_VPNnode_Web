#!/system/bin/sh
# 仅用于已核验的D22原厂开机音乐；保留原件与恢复脚本，不调整系统音量。
set -eu
expected=08fa7b0667f7d7c7457000da0cd9626bceda2735c3c2ff5e7026c8e3e07d7d64
paths='/system/media/bootaudio.mp3 /system/media/hctbootaudio_1/bootaudio.mp3 /system/media/hctbootaudio_2/bootaudio.mp3'
[ "$(id -u)" = 0 ] || exit 10
[ "$(getprop ro.board.platform)" = mt6739 ] || exit 11
for other in /custom/media/bootaudio.mp3 /data/local/bootaudio.mp3; do
    [ ! -e "$other" ] || exit 12
done
for original in $paths; do
    [ -f "$original" ] || exit 13
    actual=$(sha256sum "$original")
    [ "${actual%% *}" = "$expected" ] || exit 14
done
backup="/data/local/elfremote/boot-audio-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$backup"
getprop ro.build.fingerprint > "$backup/build.txt"
cat /proc/mounts > "$backup/mounts-before.txt"
for original in $paths; do
    mkdir -p "$backup$(dirname "$original")"
    cp -p "$original" "$backup$original"
    cmp "$original" "$backup$original"
done
# 恢复脚本只复制本次保存的三个原件。
cat > "$backup/restore.sh" <<'RESTORE'
#!/system/bin/sh
set -eu
backup=${0%/*}
mount -o remount,rw /system
trap 'mount -o remount,ro /system' EXIT
for original in /system/media/bootaudio.mp3 /system/media/hctbootaudio_1/bootaudio.mp3 /system/media/hctbootaudio_2/bootaudio.mp3; do
    cp -p "$backup$original" "$original"
    restorecon "$original"
    cmp "$backup$original" "$original"
done
sync
RESTORE
chmod 700 "$backup/restore.sh"
mount -o remount,rw /system
complete=0
cleanup() {
    if [ "$complete" = 0 ]; then sh "$backup/restore.sh"; fi
    mount -o remount,ro /system
}
trap cleanup EXIT
for original in $paths; do
    # 原文件原地保留，以时间戳后缀停用；播放器只识别原来的完整文件名。
    disabled="$original.disabled-${backup##*/}"
    [ ! -e "$disabled" ]
    mv "$original" "$disabled"
    cmp "$disabled" "$backup$original"
done
sync
complete=1
printf '开机音乐已停用；备份和恢复脚本：%s\n' "$backup"
for original in $paths; do [ ! -e "$original" ]; done
