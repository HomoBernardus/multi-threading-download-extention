document.addEventListener('DOMContentLoaded', function() {
    const downloadUrlInput = document.getElementById('downloadUrl');
    const threadCountInput = document.getElementById('threadCount');
    const startDownloadBtn = document.getElementById('startDownloadBtn');
    const downloadContainer = document.getElementById('downloadContainer');
    const settingsBtn = document.getElementById('settingsBtn');
    // 获取文本框元素
    const textArea = document.getElementById('selectedTextArea');
    
    // 从storage中读取保存的文本
    chrome.storage.local.get(['selectedText'], function(result) {
        if (result.selectedText) {
        downloadUrl.value = result.selectedText;
        // 可选：自动选中文本以便用户可以立即复制或编辑
        downloadUrl.select();
        }
    });

    // 从后台脚本获取当前下载状态
    chrome.runtime.sendMessage({action: "getDownloads"}, function(response) {
      if (response && response.downloads && response.downloads.length > 0) {
        downloadContainer.innerHTML = ''; // 清空容器
        response.downloads.forEach(download => {
          addDownloadItemToUI(download);
        });
      }
    });
    
    // 开始新下载
    startDownloadBtn.addEventListener('click', function() {
      const url = downloadUrlInput.value.trim();
      if (!url) {
        alert('请输入有效的下载链接');
        return;
      }
      
      const threadCount = parseInt(threadCountInput.value) || 5;
      
      chrome.runtime.sendMessage({
        action: "startDownload",
        url: url,
        threadCount: threadCount
      }, function(response) {
        if (response.success) {
          downloadUrlInput.value = '';
          
          // 检查是否需要清空"没有活动的下载任务"
          const emptyState = downloadContainer.querySelector('.empty-state');
          if (emptyState) {
            downloadContainer.innerHTML = '';
          }
          
          addDownloadItemToUI(response.download);
        } else {
          alert('下载失败: ' + response.error);
        }
      });
    });
    
    // 处理设置按钮点击
    settingsBtn.addEventListener('click', function() {
      chrome.runtime.openOptionsPage();
    });
    
    // 监听来自background的下载进度更新
    chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
      if (message.action === "updateProgress") {
        updateDownloadProgress(message.downloadId, message.progress, message.speed, message.timeLeft);
      } else if (message.action === "downloadComplete") {
        markDownloadComplete(message.downloadId);
      } else if (message.action === "downloadError") {
        showDownloadError(message.downloadId, message.error);
      }
    });
    
    function addDownloadItemToUI(download) {
      const downloadItem = document.createElement('div');
      downloadItem.className = 'download-item';
      downloadItem.dataset.id = download.id;
      
      downloadItem.innerHTML = `
        <div class="filename">${download.filename}</div>
        <div class="progress-container">
          <div class="progress-bar" style="width: ${download.progress || 0}%">${download.progress || 0}%</div>
        </div>
        <div class="download-info">
          <span class="speed">${download.speed || '0 KB/s'}</span>
          <span class="time-left">${download.timeLeft || '计算中...'}</span>
        </div>
        <div class="controls">
          <button class="pause-btn">${download.paused ? '继续' : '暂停'}</button>
          <button class="cancel-btn">取消</button>
        </div>
      `;
      
      downloadContainer.appendChild(downloadItem);
      
      // 为新添加的按钮绑定事件
      const pauseBtn = downloadItem.querySelector('.pause-btn');
      const cancelBtn = downloadItem.querySelector('.cancel-btn');
      
      pauseBtn.addEventListener('click', function() {
        chrome.runtime.sendMessage({
          action: download.paused ? "resumeDownload" : "pauseDownload",
          downloadId: download.id
        }, function(response) {
          if (response.success) {
            pauseBtn.textContent = download.paused ? '暂停' : '继续';
            download.paused = !download.paused;
          }
        });
      });
      
      cancelBtn.addEventListener('click', function() {
        if (confirm('确定要取消此下载任务吗？')) {
          chrome.runtime.sendMessage({
            action: "cancelDownload",
            downloadId: download.id
          }, function(response) {
            if (response.success) {
              downloadItem.remove();
              
              // 如果没有下载项，显示空状态
              if (downloadContainer.children.length === 0) {
                downloadContainer.innerHTML = '<div class="empty-state">没有活动的下载任务</div>';
              }
            }
          });
        }
      });
    }
    
    function updateDownloadProgress(downloadId, progress, speed, timeLeft) {
      const downloadItem = document.querySelector(`.download-item[data-id="${downloadId}"]`);
      if (!downloadItem) return;
      
      const progressBar = downloadItem.querySelector('.progress-bar');
      const speedSpan = downloadItem.querySelector('.speed');
      const timeLeftSpan = downloadItem.querySelector('.time-left');
      
      progressBar.style.width = `${progress}%`;
      progressBar.textContent = `${progress}%`;
      speedSpan.textContent = speed;
      timeLeftSpan.textContent = timeLeft;
    }
    
    function markDownloadComplete(downloadId) {
      const downloadItem = document.querySelector(`.download-item[data-id="${downloadId}"]`);
      if (!downloadItem) return;
      
      const progressBar = downloadItem.querySelector('.progress-bar');
      const speedSpan = downloadItem.querySelector('.speed');
      const timeLeftSpan = downloadItem.querySelector('.time-left');
      const controls = downloadItem.querySelector('.controls');
      
      progressBar.style.width = '100%';
      progressBar.textContent = '100%';
      progressBar.style.backgroundColor = '#4caf50';
      speedSpan.textContent = '已完成';
      timeLeftSpan.textContent = '';
      
      controls.innerHTML = '<button class="open-btn">打开文件</button>';
      const openBtn = controls.querySelector('.open-btn');
      openBtn.addEventListener('click', function() {
        chrome.runtime.sendMessage({
          action: "openFile",
          downloadId: downloadId
        });
      });
    }
    
    function showDownloadError(downloadId, error) {
      const downloadItem = document.querySelector(`.download-item[data-id="${downloadId}"]`);
      if (!downloadItem) return;
      
      const progressBar = downloadItem.querySelector('.progress-bar');
      const speedSpan = downloadItem.querySelector('.speed');
      const timeLeftSpan = downloadItem.querySelector('.time-left');
      
      progressBar.style.backgroundColor = '#f44336';
      speedSpan.textContent = '错误';
      timeLeftSpan.textContent = error;
    }
  });