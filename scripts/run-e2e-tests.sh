#!/bin/bash
# E2E 测试运行脚本

echo "========================================"
echo "Bodhi E2E 测试运行脚本"
echo "========================================"
echo ""

# 检查后端是否运行
echo "检查后端服务..."
if curl -s http://localhost:9562/v1/health > /dev/null; then
    echo "✅ 后端已运行在 localhost:9562"
else
    echo "⚠️  后端未运行，尝试启动..."
    
    # 检查是否有编译好的二进制文件
    if [ -f "~/workspace/bodhi/target/release/web_service_standalone" ]; then
        echo "使用 release 版本启动后端..."
        ~/workspace/bodhi/target/release/web_service_standalone --port 9562 --data-dir /tmp/test-data &
    elif [ -f "~/workspace/bodhi/target/debug/web_service_standalone" ]; then
        echo "使用 debug 版本启动后端..."
        ~/workspace/bodhi/target/debug/web_service_standalone --port 9562 --data-dir /tmp/test-data &
    else
        echo "正在编译后端（可能需要几分钟）..."
        cd ~/workspace/bodhi
        export PATH="$HOME/.cargo/bin:$PATH"
        cargo build --release -p web_service_standalone
        ~/workspace/bodhi/target/release/web_service_standalone --port 9562 --data-dir /tmp/test-data &
    fi
    
    # 等待后端启动
    echo "等待后端启动..."
    for i in {1..30}; do
        if curl -s http://localhost:9562/v1/health > /dev/null; then
            echo "✅ 后端已启动"
            break
        fi
        sleep 2
        echo -n "."
    done
    
    if ! curl -s http://localhost:9562/v1/health > /dev/null; then
        echo "❌ 后端启动失败"
        exit 1
    fi
fi

echo ""
echo "========================================"
echo "运行 E2E 测试"
echo "========================================"
echo ""

cd ~/workspace/bodhi/e2e

# 运行测试
echo "运行所有测试..."
npm run test

echo ""
echo "========================================"
echo "测试完成"
echo "========================================"
