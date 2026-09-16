#!/system/bin/sh
# Restore all packages disabled by pixel_gateway_debloat.sh.

for package in $(sed -n '/^packages=/,$p' /data/local/tmp/pixel_gateway_debloat.sh | tr "'" ' ' | tr '\\' ' '); do
  case "$package" in
    com.*) cmd package install-existing --user 0 "$package" ;;
  esac
done
