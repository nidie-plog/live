# 零依赖 DeepSeek 代理镜像（阿里云函数计算自定义镜像部署 / 任意 Docker 环境通用）
# 构建：docker build -t tarot-proxy .
# 本地测试：docker run -p 3000:9000 -e DEEPSEEK_API_KEY=sk-xxx tarot-proxy
FROM node:18-slim

WORKDIR /app

# 仅一个文件，零依赖，镜像最小化
COPY server.js ./

# 函数计算自定义镜像约定监听 9000 端口
ENV PORT=9000

EXPOSE 9000

CMD ["node", "server.js"]
