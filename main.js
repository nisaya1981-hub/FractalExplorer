const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Global reference to the main window to prevent garbage collection
let mainWindow = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        title: 'Eagle Mode Flat UI Explorer',
        backgroundColor: '#090d16',
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false // Allows loading local file protocols and images smoothly
        }
    });

    // Remove default menu bar for clean UI
    mainWindow.setMenuBarVisibility(false);

    // Load main entry point
    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    // Show window smoothly when ready
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

/**
 * IPC Handler: Native System Folder / Drive Selection Dialog
 */
ipcMain.handle('dialog:openDirectory', async () => {
    if (!mainWindow) return { canceled: true, filePaths: [] };

    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Select Folder(s) or Drive to Explore',
            properties: ['openDirectory', 'multiSelections', 'dontResolveSymlinks']
        });
        return result;
    } catch (err) {
        console.error('Failed to open directory dialog:', err);
        return { canceled: true, error: err.message };
    }
});

/**
 * IPC Handler: Fast Native Directory Scanner
 */
ipcMain.handle('fs:readDir', async (event, dirPath) => {
    try {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        const result = [];

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            let isDirectory = false;
            let size = 0;

            try {
                isDirectory = entry.isDirectory();
                if (!isDirectory) {
                    const stats = await fs.promises.stat(fullPath);
                    size = stats.size;
                }
            } catch (e) {
                // Ignore permission/symlink errors
            }

            const ext = entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : '';

            result.push({
                name: entry.name,
                path: fullPath,
                type: isDirectory ? 'folder' : 'file',
                ext: ext,
                size: size
            });
        }

        return { success: true, items: result };
    } catch (err) {
        return { success: false, error: err.message, items: [] };
    }
});

/**
 * IPC Handler: Fast File Preview Reader (Max 50KB to avoid memory locks)
 */
ipcMain.handle('fs:readFilePreview', async (event, { filePath, maxBytes = 524288 }) => {
    try {
        const handle = await fs.promises.open(filePath, 'r');
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        await handle.close();

        return {
            success: true,
            content: buffer.toString('utf8', 0, bytesRead)
        };
    } catch (err) {
        return { success: false, error: err.message, content: '' };
    }
});

/**
 * IPC Handler: Open file/folder in system default viewer
 */
ipcMain.handle('shell:openPath', async (event, targetPath) => {
    try {
        const errorMessage = await shell.openPath(targetPath);
        return { success: !errorMessage, error: errorMessage };
    } catch (err) {
        return { success: false, error: err.message };
    }
});