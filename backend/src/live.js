const clients = new Set();

function addClient(response) {
  clients.add(response);
  response.on("close", () => clients.delete(response));
}

function publish(event) {
  const message = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

module.exports = { addClient, publish };
