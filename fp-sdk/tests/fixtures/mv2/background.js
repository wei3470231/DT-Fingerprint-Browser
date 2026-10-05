chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.ping === 'fp-sdk-test') { reply({ pong:'mv2' }); }
});
