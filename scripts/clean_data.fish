#!/usr/bin/env fish

# Clean all historical chat data to fix serialization errors
# This script removes old data that uses PascalCase state names (e.g., "Idle")
# The new backend expects snake_case state names (e.g., "idle")

echo "🧹 Cleaning historical chat data..."
echo ""

# Find the data directory
# Default location for Tauri app data
set APP_DATA_DIR ""

switch (uname)
    case Darwin
        # macOS
        set APP_DATA_DIR "$HOME/Library/Application Support/com.bodhi.app"
    case Linux
        # Linux
        set APP_DATA_DIR "$HOME/.local/share/com.bodhi.app"
    case '*'
        echo "❌ Unsupported OS: "(uname)
        exit 1
end

echo "📁 App data directory: $APP_DATA_DIR"
echo ""

# Check if directory exists
if not test -d "$APP_DATA_DIR"
    echo "✅ No data directory found. Nothing to clean."
    exit 0
end

# Backup data before deletion (optional)
set BACKUP_DIR "$APP_DATA_DIR.backup."(date +%Y%m%d_%H%M%S)
echo "💾 Creating backup at: $BACKUP_DIR"
cp -r "$APP_DATA_DIR" "$BACKUP_DIR"
echo "✅ Backup created"
echo ""

# Remove conversations directory
set CONVERSATIONS_DIR "$APP_DATA_DIR/conversations"
if test -d "$CONVERSATIONS_DIR"
    echo "🗑️  Removing conversations directory..."
    rm -rf "$CONVERSATIONS_DIR"
    echo "✅ Conversations removed"
else
    echo "ℹ️  No conversations directory found"
end

# Remove sessions directory
set SESSIONS_DIR "$APP_DATA_DIR/sessions"
if test -d "$SESSIONS_DIR"
    echo "🗑️  Removing sessions directory..."
    rm -rf "$SESSIONS_DIR"
    echo "✅ Sessions removed"
else
    echo "ℹ️  No sessions directory found"
end

echo ""
echo "✅ Data cleanup complete!"
echo ""
echo "📝 Summary:"
echo "   - Backup created at: $BACKUP_DIR"
echo "   - Conversations removed: $CONVERSATIONS_DIR"
echo "   - Sessions removed: $SESSIONS_DIR"
echo ""
echo "🚀 You can now restart the application with clean data."
echo ""
echo "⚠️  If you need to restore the backup:"
echo "   rm -rf '$APP_DATA_DIR'"
echo "   mv '$BACKUP_DIR' '$APP_DATA_DIR'"
