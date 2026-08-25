#!/bin/sh
# ==============================================================================
# XKeenSwitcher - Скрипт установки для среды Entware (Keenetic / OpenWrt)
# ==============================================================================

set -e

INSTALL_DIR="/opt/etc/xkeen-switcher"
INIT_SCRIPT="/opt/etc/init.d/S99xkeen-switcher"
REPO_OWNER="sergey1900"
REPO_NAME="XKeenSwitcher"
REPO_BRANCH="main"
DEFAULT_PORT="3000"

OUTBOUND_PATH="/opt/etc/xray/configs/05_outbounds.json"
ROUTING_PATH="/opt/etc/xray/configs/03_routing.json"

# Альтернативные пути к файлам xray в зависимости от сборки
[ ! -f "$OUTBOUND_PATH" ] && [ -f "/opt/etc/xray/configs/04_outbounds.json" ] && OUTBOUND_PATH="/opt/etc/xray/configs/04_outbounds.json"
[ ! -f "$ROUTING_PATH" ] && [ -f "/opt/etc/xray/configs/04_routing.json" ] && ROUTING_PATH="/opt/etc/xray/configs/04_routing.json"

# Цвета для вывода в терминал
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${CYAN}${BOLD}====================================================${NC}"
echo -e "${CYAN}${BOLD}       Установка XKeenSwitcher в Entware            ${NC}"
echo -e "${CYAN}${BOLD}====================================================${NC}"
echo ""

# 1. Проверка окружения Entware
if [ ! -d "/opt/bin" ] || [ ! -x "/opt/bin/opkg" ]; then
  echo -e "${RED}[ОШИБКА] Среда Entware не обнаружена! Скрипт должен запускаться на роутере с установленным Entware (/opt).${NC}"
  exit 1
fi

export PATH=/opt/sbin:/opt/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH

# 2. Проверка и установка зависимостей
echo -e "${BLUE}[1/5] Проверка необходимых пакетов...${NC}"

PACKAGES_TO_INSTALL=""

if ! command -v node >/dev/null 2>&1; then
  echo -e "  - Node.js: ${YELLOW}не установлен${NC}"
  PACKAGES_TO_INSTALL="$PACKAGES_TO_INSTALL node"
else
  NODE_VER=$(node -v 2>/dev/null || echo "установлен")
  echo -e "  - Node.js: ${GREEN}OK ($NODE_VER)${NC}"
fi

if ! command -v curl >/dev/null 2>&1; then
  echo -e "  - curl: ${YELLOW}не установлен${NC}"
  PACKAGES_TO_INSTALL="$PACKAGES_TO_INSTALL curl"
else
  echo -e "  - curl: ${GREEN}OK${NC}"
fi

if ! command -v tar >/dev/null 2>&1; then
  echo -e "  - tar: ${YELLOW}не установлен${NC}"
  PACKAGES_TO_INSTALL="$PACKAGES_TO_INSTALL tar"
fi

if [ ! -f "/opt/etc/ssl/certs/ca-certificates.crt" ] && [ ! -d "/etc/ssl/certs" ]; then
  PACKAGES_TO_INSTALL="$PACKAGES_TO_INSTALL ca-certificates ca-bundle"
fi

if [ -n "$PACKAGES_TO_INSTALL" ]; then
  echo -e "${YELLOW}[!] Обновление пакетов и установка:$PACKAGES_TO_INSTALL...${NC}"
  opkg update
  # shellcheck disable=SC2086
  opkg install $PACKAGES_TO_INSTALL
  echo -e "${GREEN}[OK] Необходимые пакеты успешно установлены.${NC}"
fi

# 3. Скачивание и распаковка XKeenSwitcher
echo -e "${BLUE}[2/5] Загрузка XKeenSwitcher с GitHub...${NC}"

TMP_DIR="/opt/tmp/xkeen-switcher-install"
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"
mkdir -p "$INSTALL_DIR"
mkdir -p "/opt/var/run"
mkdir -p "/opt/var/log"

ARCHIVE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/${REPO_BRANCH}.tar.gz"

DOWNLOAD_SUCCESS=0

# Пробуем скачать публичный архив или используем GITHUB_TOKEN при наличии
if [ -n "$GITHUB_TOKEN" ]; then
  echo -e "  Используется переданный токен GitHub..."
  if curl -sL -H "Authorization: token $GITHUB_TOKEN" "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/tarball/${REPO_BRANCH}" -o "$TMP_DIR/app.tar.gz"; then
    DOWNLOAD_SUCCESS=1
  fi
fi

if [ "$DOWNLOAD_SUCCESS" -eq 0 ]; then
  if curl -sL "$ARCHIVE_URL" -o "$TMP_DIR/app.tar.gz" && [ -s "$TMP_DIR/app.tar.gz" ]; then
    # Проверим, что это валидный gzip/tar архив, а не страница 404/ошибки
    if tar -tzf "$TMP_DIR/app.tar.gz" >/dev/null 2>&1; then
      DOWNLOAD_SUCCESS=1
    fi
  fi
fi

if [ "$DOWNLOAD_SUCCESS" -eq 0 ]; then
  echo -e "${YELLOW}[!] Репозиторий приватный или архив не скачался напрямую.${NC}"
  INPUT_TOKEN=""
  if [ -r /dev/tty ]; then
    printf "Пожалуйста, введите ваш Personal Access Token (GitHub Token) или нажмите Enter для отмены: " > /dev/tty
    read -r INPUT_TOKEN < /dev/tty
  else
    printf "Пожалуйста, введите ваш Personal Access Token (GitHub Token) или нажмите Enter для отмены: "
    read -r INPUT_TOKEN
  fi

  if [ -n "$INPUT_TOKEN" ]; then
    if curl -sL -H "Authorization: token $INPUT_TOKEN" "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/tarball/${REPO_BRANCH}" -o "$TMP_DIR/app.tar.gz"; then
      DOWNLOAD_SUCCESS=1
    fi
  fi
fi

if [ "$DOWNLOAD_SUCCESS" -eq 0 ] || [ ! -s "$TMP_DIR/app.tar.gz" ]; then
  echo -e "${RED}[ОШИБКА] Не удалось скачать архив проекта с GitHub.${NC}"
  rm -rf "$TMP_DIR"
  exit 1
fi

echo -e "  Распаковка файлов в $INSTALL_DIR..."
tar -xzf "$TMP_DIR/app.tar.gz" -C "$TMP_DIR"
SRC_EXTRACTED=$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)

if [ -z "$SRC_EXTRACTED" ] || [ ! -f "$SRC_EXTRACTED/server.js" ]; then
  echo -e "${RED}[ОШИБКА] В архиве не найден server.js${NC}"
  rm -rf "$TMP_DIR"
  exit 1
fi

# Сохраняем существующие пользовательские профили при обновлении
if [ -f "$INSTALL_DIR/data/profiles.json" ]; then
  echo -e "  Сохранение существующего $INSTALL_DIR/data/profiles.json..."
  cp "$INSTALL_DIR/data/profiles.json" "$TMP_DIR/profiles_backup.json"
fi

# Копируем проект
cp -rf "$SRC_EXTRACTED"/* "$INSTALL_DIR"/

# Восстанавливаем бэкап профилей если был
if [ -f "$TMP_DIR/profiles_backup.json" ]; then
  mkdir -p "$INSTALL_DIR/data"
  cp "$TMP_DIR/profiles_backup.json" "$INSTALL_DIR/data/profiles.json"
fi

rm -rf "$TMP_DIR"
echo -e "${GREEN}[OK] Файлы приложения установлены в $INSTALL_DIR${NC}"

# 4. Инициализация профиля по умолчанию (Default) из существующих конфигураций
echo -e "${BLUE}[3/5] Инициализация начальной конфигурации профилей...${NC}"

mkdir -p "$INSTALL_DIR/data"

node -e "
const fs = require('fs');
const path = require('path');

const dataFile = path.join('$INSTALL_DIR', 'data', 'profiles.json');
const outboundPath = '$OUTBOUND_PATH';
const routingPath = '$ROUTING_PATH';

let data = {
  settings: {
    outboundPath: outboundPath,
    routingPath: routingPath,
    restartCommand: 'xkeen -restart',
    startCommand: 'xkeen -start',
    stopCommand: 'xkeen -stop',
    statusCommand: 'xkeen -status',
    activeProfileId: null,
    port: parseInt('$DEFAULT_PORT', 10) || 3000
  },
  profiles: []
};

if (fs.existsSync(dataFile)) {
  try {
    const existing = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    data = { ...data, ...existing };
    data.settings = { ...data.settings, ...(existing.settings || {}) };
  } catch (e) {
    console.error('Ошибка чтения существующего profiles.json:', e.message);
  }
}

// Если профилей нет, создаем профиль Default из существующих файлов на роутере
if (!data.profiles || data.profiles.length === 0) {
  let outboundContent = '{\n  \"outbounds\": []\n}';
  let routingContent = '{\n  \"routing\": {\n    \"rules\": []\n  }\n}';
  let extractedAddress = '';

  if (fs.existsSync(outboundPath)) {
    try {
      outboundContent = fs.readFileSync(outboundPath, 'utf8').trim();
      
      // Извлечение адреса сервера
      try {
        const clean = outboundContent.replace(/(\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)/g, '');
        const parsed = JSON.parse(clean);
        const list = Array.isArray(parsed.outbounds) ? parsed.outbounds : [parsed];
        for (const ob of list) {
          if (!ob || ob.tag === 'direct' || ob.tag === 'block') continue;
          if (ob.settings && ob.settings.vnext && ob.settings.vnext[0] && ob.settings.vnext[0].address) {
            extractedAddress = ob.settings.vnext[0].address;
            break;
          }
          if (ob.settings && ob.settings.servers && ob.settings.servers[0] && ob.settings.servers[0].address) {
            extractedAddress = ob.settings.servers[0].address;
            break;
          }
        }
      } catch (err) {}

      if (!extractedAddress) {
        const match = outboundContent.match(/\"address\"\s*:\s*\"([^\"]+)\"/i);
        if (match && match[1]) {
          extractedAddress = match[1];
        }
      }
    } catch (e) {
      console.error('Не удалось прочитать ' + outboundPath + ':', e.message);
    }
  }

  if (fs.existsSync(routingPath)) {
    try {
      routingContent = fs.readFileSync(routingPath, 'utf8').trim();
    } catch (e) {
      console.error('Не удалось прочитать ' + routingPath + ':', e.message);
    }
  }

  const defaultProfileId = 'prof_default_' + Date.now();
  const description = extractedAddress ? extractedAddress : 'Текущая конфигурация роутера';

  const defaultProfile = {
    id: defaultProfileId,
    name: 'Default',
    description: description,
    outboundContent: outboundContent,
    routingContent: routingContent,
    createdAt: new Date().toISOString()
  };

  data.profiles = [defaultProfile];
  data.settings.activeProfileId = defaultProfileId;
  console.log('Создан профиль Default' + (extractedAddress ? ' (адрес в описании: ' + extractedAddress + ')' : ''));
}

fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
"

echo -e "${GREEN}[OK] Конфигурация успешно сохранена в $INSTALL_DIR/data/profiles.json${NC}"

# 5. Создание службы автозапуска /opt/etc/init.d/S99xkeen-switcher
echo -e "${BLUE}[4/5] Настройка службы автозапуска Entware...${NC}"

cat << 'INIT_EOF' > "$INIT_SCRIPT"
#!/bin/sh

ENABLED=yes
PROCS=node
DESC="XKeenSwitcher"
PIDFILE="/opt/var/run/xkeen-switcher.pid"
LOGFILE="/opt/var/log/xkeen-switcher.log"
APP_DIR="/opt/etc/xkeen-switcher"
SERVER_JS="$APP_DIR/server.js"
PATH=/opt/sbin:/opt/bin:/usr/sbin:/usr/bin:/sbin:/bin

start() {
  if [ -f "$PIDFILE" ] && kill -0 $(cat "$PIDFILE") 2>/dev/null; then
    echo "$DESC is already running (pid $(cat "$PIDFILE"))."
    return 0
  fi

  echo -n "Starting $DESC... "
  if [ ! -f "$SERVER_JS" ]; then
    echo "Error: $SERVER_JS not found!"
    return 1
  fi

  cd "$APP_DIR" || exit 1
  node "$SERVER_JS" >> "$LOGFILE" 2>&1 &
  PID=$!
  echo $PID > "$PIDFILE"
  echo "done (pid $PID)."
}

stop() {
  echo -n "Stopping $DESC... "
  if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null
      sleep 1
      if kill -0 "$PID" 2>/dev/null; then
        kill -9 "$PID" 2>/dev/null
      fi
    fi
    rm -f "$PIDFILE"
  else
    killall -q node 2>/dev/null || true
  fi
  echo "done."
}

restart() {
  stop
  sleep 1
  start
}

status() {
  if [ -f "$PIDFILE" ] && kill -0 $(cat "$PIDFILE") 2>/dev/null; then
    echo "$DESC is running (pid $(cat "$PIDFILE"))."
    return 0
  else
    echo "$DESC is stopped."
    return 1
  fi
}

case "$1" in
  start)
    start
    ;;
  stop)
    stop
    ;;
  restart)
    restart
    ;;
  status)
    status
    ;;
  check)
    status
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac

exit 0
INIT_EOF

chmod +x "$INIT_SCRIPT"
echo -e "${GREEN}[OK] Служба создана: $INIT_SCRIPT${NC}"

# 6. Запуск службы
echo -e "${BLUE}[5/5] Запуск XKeenSwitcher...${NC}"
"$INIT_SCRIPT" restart

# 7. Определение IP адреса роутера для вывода ссылки
ROUTER_IP=""

if command -v ndmc >/dev/null 2>&1; then
  ROUTER_IP=$(ndmc -c 'show interface Home' 2>/dev/null | grep -i 'address:' | head -n 1 | awk '{print $2}' || true)
fi

if [ -z "$ROUTER_IP" ]; then
  ROUTER_IP=$(ip -4 addr show br0 2>/dev/null | grep -o 'inet [0-9.]*' | awk '{print $2}' || true)
fi

if [ -z "$ROUTER_IP" ]; then
  ROUTER_IP=$(ip -4 addr show br-lan 2>/dev/null | grep -o 'inet [0-9.]*' | awk '{print $2}' || true)
fi

if [ -z "$ROUTER_IP" ]; then
  ROUTER_IP=$(ip route get 1.1.1.1 2>/dev/null | grep -o 'src [0-9.]*' | awk '{print $2}' || true)
fi

if [ -z "$ROUTER_IP" ]; then
  ROUTER_IP="192.168.1.1"
fi

APP_URL="http://${ROUTER_IP}:${DEFAULT_PORT}"

echo ""
echo -e "${GREEN}${BOLD}====================================================${NC}"
echo -e "${GREEN}${BOLD}      XKeenSwitcher успешно установлен и запущен!   ${NC}"
echo -e "${GREEN}${BOLD}====================================================${NC}"
echo ""
echo -e "Веб-интерфейс доступен по ссылке:"
echo -e "${CYAN}${BOLD}👉  ${APP_URL}  👈${NC}"
echo ""
echo -e "Управление службой:"
echo -e "  Статус:      ${YELLOW}$INIT_SCRIPT status${NC}"
echo -e "  Перезапуск:  ${YELLOW}$INIT_SCRIPT restart${NC}"
echo -e "  Остановка:   ${YELLOW}$INIT_SCRIPT stop${NC}"
echo -e "  Логи:        ${YELLOW}tail -f /opt/var/log/xkeen-switcher.log${NC}"
echo ""
