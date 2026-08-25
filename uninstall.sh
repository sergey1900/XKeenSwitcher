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
echo -e "${CYAN}${BOLD}         Удаление XKeenSwitcher                     ${NC}"
echo -e "${CYAN}${BOLD}====================================================${NC}"
echo ""

# 1. Остановка службы
echo -e "${BLUE}[1/4] Остановка службы...${NC}"
if [ -f "$INIT_SCRIPT" ]; then
  "$INIT_SCRIPT" stop 2>/dev/null || true
fi

if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 1
    kill -9 "$PID" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi

echo -e "${GREEN}[OK] Служба остановлена.${NC}"

# 2. Удаление скрипта автозапуска
echo -e "${BLUE}[2/4] Удаление скрипта автозапуска...${NC}"
if [ -f "$INIT_SCRIPT" ]; then
  rm -f "$INIT_SCRIPT"
  echo -e "  Удален $INIT_SCRIPT"
fi

# 3. Удаление файлов приложения
echo -e "${BLUE}[3/4] Удаление файлов приложения...${NC}"
REMOVE_FILES="y"
if [ -r /dev/tty ]; then
  printf "Удалить директорию приложения %s вместе с профилями? (y/n) [y]: " "$INSTALL_DIR" > /dev/tty
  read -r REMOVE_FILES < /dev/tty
fi

if [ -z "$REMOVE_FILES" ] || [ "$REMOVE_FILES" = "y" ] || [ "$REMOVE_FILES" = "Y" ] || [ "$REMOVE_FILES" = "д" ] || [ "$REMOVE_FILES" = "Д" ]; then
  rm -rf "$INSTALL_DIR"
  rm -f "$LOGFILE"
  echo -e "${GREEN}[OK] Файлы приложения и логи успешно удалены.${NC}"
else
  echo -e "${YELLOW}[!] Директория $INSTALL_DIR сохранена.${NC}"
fi

# 4. Вопрос про пакет Node.js
echo -e "${BLUE}[4/4] Проверка зависимостей...${NC}"
REMOVE_NODE="n"
if [ -r /dev/tty ]; then
  printf "Удалить пакет Node.js из Entware (opkg remove node)? (y/n) [n]: " > /dev/tty
  read -r REMOVE_NODE < /dev/tty
fi

if [ "$REMOVE_NODE" = "y" ] || [ "$REMOVE_NODE" = "Y" ] || [ "$REMOVE_NODE" = "д" ] || [ "$REMOVE_NODE" = "Д" ]; then
  echo -e "  Удаление Node.js..."
  opkg remove node || true
  echo -e "${GREEN}[OK] Node.js удален.${NC}"
else
  echo -e "  Node.js сохранен в системе."
fi

echo ""
echo -e "${GREEN}${BOLD}====================================================${NC}"
echo -e "${GREEN}${BOLD}       XKeenSwitcher успешно удален!                ${NC}"
echo -e "${GREEN}${BOLD}====================================================${NC}"
echo ""
