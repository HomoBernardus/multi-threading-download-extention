// background.js - 使用Fetch API的扩展后台服务工作线程
// 当扩展安装或更新时创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "multiThreadingDownload",
        title: "多线程下载",
        contexts: ["selection", "link"] // 可以是 "page", "selection", "link", "image" 等
    });
});

// 处理右键菜单点击事件
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "multiThreadingDownload") {
        if (info.selectionText) {
            // 处理选中文本
            // 存储选中的文本
            chrome.storage.local.set({ selectedText: info.selectionText }, function () {
                console.log("文本已保存:", info.selectionText);
            });
        }
        if (info.linkUrl) {
            // 处理链接
            // 存储选中的文本
            chrome.storage.local.set({ selectedText: info.linkUrl }, function () {
                console.log("文本已保存:", info.linkUrl);
            });
        }

        // 打开popup
        chrome.action.openPopup();
    }
});

// 下载管理器类
class MultiThreadDownloader {
    constructor() {
        this.downloads = {};
        this.nextId = 1;
        this.loadSettings();
    }

    // 加载设置
    loadSettings() {
        chrome.storage.sync.get({
            'defaultThreads': 5,
            'speedLimit': 0,
            'autoStart': true,
            'downloadFolder': ''
        }, (items) => {
            this.settings = items;
        });
    }

    // 开始新的下载
    async startDownload(url, threadCount = this.settings.defaultThreads) {
        try {
            // 获取文件信息
            const fileInfo = await this.getFileInfo(url);
            if (!fileInfo.supportsRange) {
                throw new Error("服务器不支持断点续传，无法使用多线程下载");
            }

            const downloadId = this.nextId++;
            const filename = this.getFilenameFromUrl(url);

            // 创建下载任务
            this.downloads[downloadId] = {
                id: downloadId,
                url: url,
                filename: filename,
                fileSize: fileInfo.fileSize,
                progress: 0,
                threads: [],
                threadCount: threadCount,
                paused: false,
                bytesDownloaded: 0,
                startTime: Date.now(),
                speed: '0 KB/s',
                timeLeft: '计算中...',
                chunks: [],
                status: 'active'
            };

            // 分配下载块
            const chunkSize = Math.floor(fileInfo.fileSize / threadCount);

            for (let i = 0; i < threadCount; i++) {
                const startByte = i * chunkSize;
                const endByte = (i === threadCount - 1) ? fileInfo.fileSize - 1 : (i + 1) * chunkSize - 1;

                this.downloads[downloadId].chunks.push({
                    index: i,
                    startByte: startByte,
                    endByte: endByte,
                    bytesDownloaded: 0,
                    status: 'waiting'
                });
            }

            // 开始所有线程的下载
            for (let chunk of this.downloads[downloadId].chunks) {
                this.startChunkDownload(downloadId, chunk.index);
            }

            // 启动进度更新计时器
            this.startProgressUpdater(downloadId);

            return {
                success: true,
                download: this.getDownloadInfo(downloadId)
            };
        } catch (error) {
            console.error("下载启动失败:", error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // 获取文件信息，使用fetch替代XMLHttpRequest
    async getFileInfo(url) {
        try {
            const response = await fetch(url, {
                method: 'HEAD',
            });

            if (!response.ok) {
                throw new Error(`服务器返回错误: ${response.status}`);
            }

            const fileSize = parseInt(response.headers.get('Content-Length'));
            const acceptRanges = response.headers.get('Accept-Ranges');
            const supportsRange = acceptRanges === 'bytes';

            return {
                fileSize: fileSize,
                supportsRange: supportsRange
            };
        } catch (error) {
            throw new Error('无法连接到服务器: ' + error.message);
        }
    }

    // 从URL提取文件名
    getFilenameFromUrl(url) {
        try {
            const urlObj = new URL(url);
            const pathname = urlObj.pathname;
            let filename = pathname.split('/').pop();

            // 如果文件名为空或没有扩展名，使用默认名称
            if (!filename || filename.indexOf('.') === -1) {
                filename = 'download_' + Date.now();
            }

            // 解码URL编码的文件名
            return decodeURIComponent(filename);
        } catch (e) {
            return 'download_' + Date.now();
        }
    }

    // 开始下载特定块，使用fetch替代XMLHttpRequest
    async startChunkDownload(downloadId, chunkIndex) {
        const download = this.downloads[downloadId];
        if (!download) return;

        const chunk = download.chunks[chunkIndex];
        if (!chunk || chunk.status === 'complete') return;

        chunk.status = 'downloading';

        // 在内存中保存块数据
        chunk.data = new Uint8Array();

        try {
            // 创建AbortController用于取消fetch请求
            const controller = new AbortController();
            download.threads[chunkIndex] = controller;

            const response = await fetch(download.url, {
                headers: {
                    'Range': `bytes=${chunk.startByte + chunk.bytesDownloaded}-${chunk.endByte}`
                },
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`服务器返回错误: ${response.status}`);
            }

            // 获取总大小信息
            const contentLength = parseInt(response.headers.get('Content-Length'));

            // 使用ReadableStream API处理下载进度
            const reader = response.body.getReader();
            let receivedLength = 0;

            // 使用链式promise处理数据流
            while (true) {
                // 检查下载是否还存在或被暂停
                if (!this.downloads[downloadId] || this.downloads[downloadId].paused) {
                    reader.cancel();
                    return;
                }

                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                // 处理新接收的数据块
                const newData = new Uint8Array(value);
                const combinedData = new Uint8Array(chunk.data.length + newData.length);
                combinedData.set(chunk.data);
                combinedData.set(newData, chunk.data.length);
                chunk.data = combinedData;

                // 更新已下载字节数
                receivedLength += newData.length;
                chunk.bytesDownloaded = receivedLength;

                // 更新总下载进度
                this.updateTotalProgress(downloadId);
            }

            // 数据流接收完成，更新状态
            chunk.status = 'complete';
            this.updateTotalProgress(downloadId);

            // 检查是否所有块都已完成
            if (this.isDownloadComplete(downloadId)) {
                this.finalizeDownload(downloadId);
            }

        } catch (error) {
            // 如果不是因为暂停或取消引起的错误
            if (this.downloads[downloadId] && !error.name === 'AbortError') {
                console.error(`块 ${chunkIndex} 下载出错:`, error.message);
                chunk.status = 'error';

                // 尝试重新下载此块
                setTimeout(() => {
                    if (this.downloads[downloadId] && !this.downloads[downloadId].paused) {
                        console.log(`尝试重新下载块 ${chunkIndex}`);
                        this.startChunkDownload(downloadId, chunkIndex);
                    }
                }, 3000);
            }
        }
    }

    // 更新总下载进度
    updateTotalProgress(downloadId) {
        const download = this.downloads[downloadId];
        if (!download) return;

        let totalDownloaded = 0;
        for (const chunk of download.chunks) {
            totalDownloaded += chunk.bytesDownloaded;
        }

        download.bytesDownloaded = totalDownloaded;
        download.progress = Math.round((totalDownloaded / download.fileSize) * 100);

        // 计算下载速度和剩余时间在进度更新器中处理
    }

    // 启动进度更新计时器
    startProgressUpdater(downloadId) {
        const updateInterval = setInterval(() => {
            const download = this.downloads[downloadId];
            if (!download) {
                clearInterval(updateInterval);
                return;
            }

            if (download.paused || download.status !== 'active') return;

            const currentTime = Date.now();
            const elapsedTime = (currentTime - download.startTime) / 1000; // 秒

            if (elapsedTime > 0 && download.bytesDownloaded > 0) {
                // 计算速度 (bytes/second)
                const speedBps = download.bytesDownloaded / elapsedTime;
                download.speed = this.formatSpeed(speedBps);

                // 计算剩余时间
                if (speedBps > 0) {
                    const remainingBytes = download.fileSize - download.bytesDownloaded;
                    const remainingSeconds = remainingBytes / speedBps;
                    download.timeLeft = this.formatTimeLeft(remainingSeconds);
                }

                // 通知UI更新
                chrome.runtime.sendMessage({
                    action: "updateProgress",
                    downloadId: downloadId,
                    progress: download.progress,
                    speed: download.speed,
                    timeLeft: download.timeLeft
                });
            }

            // 检查下载是否已完成
            if (this.isDownloadComplete(downloadId)) {
                clearInterval(updateInterval);
                this.finalizeDownload(downloadId);
            }
        }, 1000);

        this.downloads[downloadId].progressUpdater = updateInterval;
    }

    // 检查下载是否完成
    isDownloadComplete(downloadId) {
        const download = this.downloads[downloadId];
        if (!download) return true;

        for (const chunk of download.chunks) {
            if (chunk.status !== 'complete') {
                return false;
            }
        }
        return true;
    }

    // 完成下载，合并所有块
    finalizeDownload(downloadId) {
        const download = this.downloads[downloadId];
        if (!download || download.status === 'complete') return;

        download.status = 'finalizing';

        // 创建合并的文件数据
        const totalSize = download.fileSize;
        const finalData = new Uint8Array(totalSize);

        let offset = 0;
        for (const chunk of download.chunks) {
            finalData.set(chunk.data, chunk.startByte);

            // 释放块数据内存
            delete chunk.data;
        }

        // 创建Blob并下载
        const blob = new Blob([finalData], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);

        chrome.downloads.download({
            url: url,
            filename: download.filename,
            saveAs: false
        }, (chromeDownloadId) => {
            download.chromeDownloadId = chromeDownloadId;
            download.status = 'complete';
            download.progress = 100;

            // 清理进度更新计时器
            if (download.progressUpdater) {
                clearInterval(download.progressUpdater);
            }

            // 通知UI下载完成
            chrome.runtime.sendMessage({
                action: "downloadComplete",
                downloadId: downloadId
            });

            // 在一段时间后释放blob URL
            setTimeout(() => {
                URL.revokeObjectURL(url);
            }, 60000);
        });
    }

    // 暂停下载
    pauseDownload(downloadId) {
        const download = this.downloads[downloadId];
        if (!download || download.status !== 'active') return false;

        download.paused = true;

        // 中止所有活动的fetch请求
        for (let controller of download.threads) {
            if (controller && controller.abort) {
                controller.abort();
            }
        }

        return true;
    }

    // 恢复下载
    resumeDownload(downloadId) {
        const download = this.downloads[downloadId];
        if (!download || download.status !== 'active') return false;

        download.paused = false;

        // 重新开始所有未完成的块
        for (let i = 0; i < download.chunks.length; i++) {
            const chunk = download.chunks[i];
            if (chunk.status !== 'complete') {
                this.startChunkDownload(downloadId, i);
            }
        }

        return true;
    }

    // 取消下载
    cancelDownload(downloadId) {
        const download = this.downloads[downloadId];
        if (!download) return false;

        // 中止所有活动的fetch请求
        for (let controller of download.threads) {
            if (controller && controller.abort) {
                controller.abort();
            }
        }

        // 清理进度更新计时器
        if (download.progressUpdater) {
            clearInterval(download.progressUpdater);
        }

        // 删除下载
        delete this.downloads[downloadId];

        return true;
    }

    // 获取下载信息
    getDownloadInfo(downloadId) {
        const download = this.downloads[downloadId];
        if (!download) return null;

        return {
            id: download.id,
            url: download.url,
            filename: download.filename,
            fileSize: download.fileSize,
            progress: download.progress,
            bytesDownloaded: download.bytesDownloaded,
            speed: download.speed,
            timeLeft: download.timeLeft,
            paused: download.paused,
            status: download.status
        };
    }

    // 获取所有下载信息
    getAllDownloads() {
        const result = [];
        for (const id in this.downloads) {
            result.push(this.getDownloadInfo(id));
        }
        return result;
    }

    // 格式化下载速度
    formatSpeed(bytesPerSecond) {
        if (bytesPerSecond < 1024) {
            return `${bytesPerSecond.toFixed(1)} B/s`;
        } else if (bytesPerSecond < 1024 * 1024) {
            return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
        } else if (bytesPerSecond < 1024 * 1024 * 1024) {
            return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
        } else {
            return `${(bytesPerSecond / (1024 * 1024 * 1024)).toFixed(1)} GB/s`;
        }
    }

    // 格式化剩余时间
    formatTimeLeft(seconds) {
        if (seconds < 60) {
            return `剩余 ${Math.ceil(seconds)} 秒`;
        } else if (seconds < 3600) {
            return `剩余 ${Math.floor(seconds / 60)} 分 ${Math.ceil(seconds % 60)} 秒`;
        } else {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            return `剩余 ${hours} 小时 ${minutes} 分`;
        }
    }

    // 打开已下载文件
    openFile(downloadId) {
        const download = this.downloads[downloadId];
        if (!download || !download.chromeDownloadId) return false;

        chrome.downloads.show(download.chromeDownloadId);
        return true;
    }
}

// 初始化下载管理器
const downloader = new MultiThreadDownloader();

// 监听来自弹出窗口的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
        switch (message.action) {
            case "startDownload":
                downloader.startDownload(message.url, message.threadCount)
                    .then(sendResponse);
                return true; // 异步响应

            case "pauseDownload":
                sendResponse({
                    success: downloader.pauseDownload(message.downloadId)
                });
                break;

            case "resumeDownload":
                sendResponse({
                    success: downloader.resumeDownload(message.downloadId)
                });
                break;

            case "cancelDownload":
                sendResponse({
                    success: downloader.cancelDownload(message.downloadId)
                });
                break;

            case "getDownloads":
                sendResponse({
                    downloads: downloader.getAllDownloads()
                });
                break;

            case "openFile":
                sendResponse({
                    success: downloader.openFile(message.downloadId)
                });
                break;

            default:
                sendResponse({ success: false, error: "未知操作" });
        }
    } catch (e) {
        console.error("处理消息时出错:", e);
        sendResponse({ success: false, error: e.message });
    }
});