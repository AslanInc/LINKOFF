document.getElementById('open').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.linkedin.com/mynetwork/invite-connect/connections/' });
  window.close();
});
