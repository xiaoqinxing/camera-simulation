#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${DEPLOY_HOST:-root@opencode.li.qinxing.xyz}"
REMOTE_DIR="${DEPLOY_PATH:-/srv/camera-simulation}"
REMOTE_DIR="${REMOTE_DIR%/}"
[ -n "$REMOTE_DIR" ] || { echo "DEPLOY_PATH 不能为空" >&2; exit 1; }
URL="${DEPLOY_URL:-https://camera-simulation.li.qinxing.xyz/}"
BACKUP_DIR="${DEPLOY_BACKUP_DIR:-/root}"

SKIP_BUILD=0
PRUNE=0

usage() {
  cat <<'EOF'
用法: npm run deploy [-- 选项]

将 dist/ 部署到静态站点。默认先构建、备份线上目录，再同步并验证。

选项:
  --skip-build   跳过 npm run build，直接部署现有 dist/
  --prune        让线上目录与 dist/ 完全一致，删除不在 dist/ 中的文件
  -h, --help     显示帮助

环境变量:
  DEPLOY_HOST         SSH 目标，默认 root@opencode.li.qinxing.xyz
  DEPLOY_PATH         线上目录，默认 /srv/camera-simulation
  DEPLOY_URL          站点根地址，默认 https://camera-simulation.li.qinxing.xyz/
  DEPLOY_BACKUP_DIR   线上备份目录，默认 /root
EOF
}

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --prune) PRUNE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

for cmd in npm ssh rsync curl md5sum; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "缺少命令: $cmd" >&2; exit 1; }
done

cd "$ROOT"

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "==> 构建"
  npm run build
fi

[ -f dist/index.html ] || { echo "dist/index.html 不存在，请先构建。" >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_DIR/camera-simulation-backup-$STAMP.tgz"

echo "==> 备份线上版本"
if ssh "$HOST" "test -d '$REMOTE_DIR'"; then
  ssh "$HOST" "mkdir -p '$BACKUP_DIR' && tar -czf '$BACKUP' -C '$(dirname "$REMOTE_DIR")' '$(basename "$REMOTE_DIR")'"
  echo "    备份: $HOST:$BACKUP"
else
  echo "    远程目录不存在，跳过备份"
  ssh "$HOST" "mkdir -p '$REMOTE_DIR'"
fi

echo "==> 同步 dist/"
RSYNC_ARGS=(-rlpt --no-owner --no-group --info=stats2)
if [ "$PRUNE" -eq 1 ]; then
  RSYNC_ARGS+=(--delete)
fi
rsync "${RSYNC_ARGS[@]}" dist/ "$HOST:$REMOTE_DIR/"

echo "==> 规范化权限"
ssh "$HOST" "find '$REMOTE_DIR' -type d -exec chmod 755 {} +; find '$REMOTE_DIR' -type f -exec chmod 644 {} +"

echo "==> 校验"
LOCAL_INDEX="$(md5sum dist/index.html | awk '{print $1}')"
REMOTE_INDEX="$(ssh "$HOST" "md5sum '$REMOTE_DIR/index.html'" | awk '{print $1}')"
[ "$LOCAL_INDEX" = "$REMOTE_INDEX" ] || { echo "index.html 校验失败" >&2; exit 1; }

BASE="${URL%/}"
check_url() {
  local code
  code="$(curl -sS -L -o /dev/null -w '%{http_code}' -I --max-time 20 "$1" || true)"
  [ "$code" = "200" ] || { echo "  ✗ $1 -> ${code:-请求失败}" >&2; exit 1; }
  echo "  ✓ $1 -> 200"
}
check_url "$BASE/"
check_url "$BASE/assets/hsrd-hsr0040-body-023-web.glb"
while IFS= read -r asset; do
  [ -n "$asset" ] && check_url "$BASE/$asset"
done < <(grep -oE '\./assets/[^"]+' dist/index.html | sed 's#^\./##')

echo
echo "部署完成: $BASE/"
echo "线上 index.html: $REMOTE_INDEX"
