#!/bin/sh
# ==============================================================================
# XKeenSwitcher - Скрипт удаления для среды Entware (Keenetic / OpenWrt)
# ==============================================================================

set -e

INSTALL_DIR="/opt/etc/xkeen-switcher"
INIT_SCRIPT="/opt/etc/init.d/S99xkeen-switcher"
PIDFILE="/opt/var/run/xkeen-switcher.pid"
LOGFILE="/opt/var/log/xkeen-switcher.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${CYAN}${BOLD}====================================================${NC}"
echo -e "${CYAN}${BOLD}       Деинсталляция XKeenSwitcher в Entware        ${NC}"
echo -e "${CYAN}${BOLD}====================================================${NC}"
echo ""

export PATH=/opt/sbin:/opt/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH

# 1. Остановка и удаление службы
echo -e "${BLUE}[1/3] Остановка службы...${NC}"

if [ -f "$INIT_SCRIPT" ]; then
  "$INIT_SCRIPT" stop 2>/dev/null || true
  rm -f "$INIT_SCRIPT"
  echo -e "  - Служба автозапуска $INIT_SCRIPT удалена."
fi

# Принудительная очистка PID файла
if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi

echo -e "${GREEN}[OK] Служба остановлена.${NC}"

# Функция для надежного интерактивного ввода
ask_confirmation() {
  PROMPT_MSG="$1"
  USER_INPUT=""
  if [ -r /dev/tty ]; then
    printf "%s" "$PROMPT_MSG" > /dev/tty
    read -r USER_INPUT < /dev/tty
  else
    printf "%s" "$PROMPT_MSG"
    read -r USER_INPUT
  fi
  
  case "$USER_INPUT" in
    y|Y|yes|Yes|YES|д|Д|да|Да|ДА)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# 2. Подтверждение удаления файлов приложения и профилей
echo ""
echo -e "${YELLOW}----------------------------------------------------${NC}"
if ask_confirmation "Удалить файлы приложения XKeenSwitcher и сохраненные профили ($INSTALL_DIR)? [y/N]: "; then
  echo -e "  Удаление файлов приложения..."
  rm -rf "$INSTALL_DIR"
  rm -f "$LOGFILE"
  echo -e "${GREEN}[OK] Файлы XKeenSwitcher удалены.${NC}"
else
  echo -e "${BLUE}[INFO] Файлы приложения и сохраненные профили оставлены в $INSTALL_DIR.${NC}"
fi

# 3. Подтверждение удаления Node.js
echo ""
echo -e "${YELLOW}----------------------------------------------------${NC}"
if command -v node >/dev/null 2>&1; then
  if ask_confirmation "Удалить пакет Node.js из Entware (opkg remove node)? [y/N]: "; then
    echo -e "  Удаление Node.js..."
    opkg remove node || true
    echo -e "${GREEN}[OK] Пакет Node.js удален из системы.${NC}"
  else
    echo -e "${BLUE}[INFO] Node.js оставлен в системе.${NC}"
  fi
else
  echo -e "${BLUE}[INFO] Node.js не найден в системе.${NC}"
fi

echo ""
echo -e "${GREEN}${BOLD}====================================================${NC}"
echo -e "${GREEN}${BOLD}     Деинсталляция успешно завершена.               ${NC}"
echo -e "${GREEN}${BOLD}====================================================${NC}"
echo ""
