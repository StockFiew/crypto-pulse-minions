const { WebsocketStream } = require('@binance/connector');
const { redis } = require('../services/redis');
const rabbit = require("./rabbitmq");
const logger = require('../utils/logger');
const env = require("../env");
const { redisWebSockets } = require("../env");

// Define callbacks for handling WebSocket stream events
const callbacks = {
	open: () => {},
	close: () => {},
	error: (error) => {
		logger.error(`Error connecting to WebSocket stream for symbol ${symbol}: ${error.message}`);
	},
	message: (data) => {
		handleMessage(data, messageCallback);
	},
};

// Define message callbacks for handling Trade and Kline messages
const messageCallback = {
	kline: (data) => {
		processKline(data);
	},
	trade: (data) => {
		processTrade(data);
	},
};

// Create a WebSocket stream for the Binance API
const wsStream = new WebsocketStream({ logger, callbacks, combinedStreams: true });
logger.debug('Binance combined stream created.');

// Define the time intervals to calculate high and low prices for
const intervals = Object.freeze(
	[5, 10, 15, 30, 60, 900, 1800, 3600, 86400, 604800, 2592000, 7776000, 15552000, 31536000, Infinity]
);

// Initialize the high and low price objects for each time interval
const [highPrices, lowPrices] = Array.from({ length: intervals.length }, () => Object.fromEntries(
	intervals.map(interval => [interval, interval === Infinity ? -Infinity : Infinity])
));

// Define variables to track successful and failed Trade and Kline messages
let [succK, succT, failK, failT] = [0, 0, 0, 0, 0, 0];

// Create a Map to store the WebSocket stream instances
const wsConnections = new Map();

// Schedule the message counter function to run every 5 seconds
setInterval(() => {
	logger.info(`WebSocket Stats (10s)
    \nSuccess: [K:${succK} T:${succT}(${succK + succT})]
    \nFailed:  [K:${failK} T:${failT}(${failK + failT})]`);
	[succK, succT, failK, failT] = [0, 0, 0, 0, 0, 0];
}, 10000);


/**
 * Connect to the WebSocket stream for Binance.
 * @returns {Promise} A Promise that resolves with the WebSocket stream instance.
 */
function connect() {
	return Promise.resolve(wsStream);
}

/**
 * Unsubscribe from a WebSocket stream for a symbol and its intervals.
 * @param {object} wsStream - The WebSocket stream instance.
 * @param {string} symbol - The symbol to unsubscribe from.
 * @param {array} intervals - The intervals to unsubscribe from.
 */
function unsubscribe(wsStream, symbol, intervals) {
	wsStream.unsubscribe(symbol);
	// Find and delete the connection string from the list
	redis.remove(env, redisWebSockets, symbol);

	for (const interval of intervals) {
		wsStream.unsubscribe(symbol, interval);
	}
	wsConnections.delete(symbol);
}

/**
 * Subscribe to a WebSocket stream for a symbol and its intervals.
 * @param {object} wsStream - The WebSocket stream instance.
 * @param {string} symbol - The symbol to subscribe to.
 * @param {array} intervals - The intervals to subscribe to.
 */
function subscribe(wsStream, symbol, intervals) {
	wsStream.trade(symbol);
	redis.pub.lpush(env.redisWebSockets, symbol, (error, result) => {
		if (error) {
			logger.error(`Error when insert symbol to Redis: ${error}`);
		}
	});
	for (const interval of intervals) {
		wsStream.kline(symbol, interval);
	}
}


/**
 * Disconnect from a WebSocket stream for a symbol and remove it from the connection pool.
 * @param {string} symbol - The symbol to disconnect from.
 */
function disconnect(symbol) {
	redis.pub.lrange(env.redisWebSockets, 0, -1, (error, result) => {
		if (error) {
			console.error(error);
		} else {
			result.forEach((value) => {
				if (value === symbol) {
					unsubscribe(wsStream, value);
				}
			});
			logger.debug(`Unsubscribed:
            ${result}`);
		}
	});
}

/**
 * Disconnect from all WebSocket streams and remove them from the connection pool.
 */
function disconnectAll() {
	redis.pub.lrange(env.redisWebSockets, 0, -1, (error, result) => {
		if (error) {
			console.error(error);
		} else {
			result.forEach((value) => {
				unsubscribe(wsStream, value);
			});
			logger.debug(`Unsubscribed:
            ${result}`);
		}
	});
}

/**
 * Handle incoming WebSocket messages.
 * @param {string} data - The message data.
 * @param {object} callbacks - The message callbacks for handling Trade and Kline messages.
 */
function handleMessage(data, callbacks) {
	const item = JSON.parse(data);
	if (!item.stream) {
		return;
	}
	const dataType = item.stream.split('@')[1].split('_')[0];
	const callback = callbacks[dataType];

	if (callback) {
		callback(item.data);
	} else {
		logger.error('Not supported stream type');
	}
}

/**
 * Processes a trade message by updating the high and low price objects for each time interval
 * and publishing the trade object, high and low prices to RabbitMQ and Redis.
 * @param {object} trade - The trade message data.
 */
function processTrade (trade) {
	// Update the high and low price objects for each time interval
	const timestamp = trade.E;
	const price = parseFloat(trade.p);
	for (const interval of intervals) {
		if (timestamp % interval === 0) {
			highPrices[interval] = Math.max(highPrices[interval], price);
			lowPrices[interval] = Math.min(lowPrices[interval], price);
		}
	}

	// Publish the trade object, high and low prices to RabbitMQ
	const tradeObject = Object.freeze({
		subId: process.pid,
		exchange: 'binance',
		eventType: trade.e,
		eventTime: trade.E,
		symbol: trade.s,
		tradeId: trade.t,
		price,
		quantity: parseFloat(trade.q),
		buyerOrderId: trade.b,
		sellerOrderId: trade.a,
		tradeTime: trade.T,
		isBuyerMarketMaker: trade.m,
		timestamp: trade.E
	});

	rabbit.sendQueue(env.wsBinance, Buffer.from(JSON.stringify(tradeObject)), 0, 0, (err) => {
		if (err) {
			failT++;
			logger.error(err);
		}
    succT++;
  });

	// Publish the trade object, high and low prices to Redis
	const channelName = `trade:${trade.s}:binance`;
	const scoreValue = JSON.stringify(tradeObject);
	const cutoff = Date.now() - 60 * 60 * 1000;

	redis.pub
		.multi()
		.zadd(channelName, timestamp, scoreValue)
		.zremrangebyscore(channelName, 0, cutoff)
		.exec()
		.then(() => {
			for (const interval of intervals) {
				if (timestamp % interval === 0) {
					const highPriceObject = Object.freeze({
						interval,
						price: highPrices[interval],
					});
					const lowPriceObject = Object.freeze({
						interval,
						price: lowPrices[interval],
					});
					const highPriceChannel = `high:${interval}:${trade.s}:binance`;
					const lowPriceChannel = `low:${interval}:${trade.s}:binance`;

					redis.pub
						.pipeline()
						.set(highPriceChannel, JSON.stringify(highPriceObject))
						.set(lowPriceChannel, JSON.stringify(lowPriceObject))
						.exec();
				}
			}

			rabbit.sendQueue(env.wsBinance, Buffer.from(JSON.stringify(tradeObject)), 0, 300, (err) => {
				if (err) {
					failT++;
					logger.error(err);
				}
				succT++;
			});
		})
		.catch((err) => {
			logger.error(`Error processing trade: ${err.message}`);
			throw err;
		});
}

/**
 * Processes a Kline message by creating a Kline object with the required data,
 * updating the high and low price objects for the Kline's time interval, and
 * publishing the Kline object to RabbitMQ and Redis.
 * @param {object} kline - The Kline message data.
 */
function processKline(kline) {
	const klineData = kline.k;

	// Create a Kline object with the required data
	const klineObject = Object.freeze({
		subId: process.pid,
		exchange: 'binance',
		eventType: kline.e,
		eventTime: klineData.t,
		symbol: klineData.s,
		interval: klineData.i,
		open: parseFloat(klineData.o),
		high: parseFloat(klineData.h),
		low: parseFloat(klineData.l),
		close: parseFloat(klineData.c),
		volume: parseFloat(klineData.v),
		trades: klineData.n,
		isFinal: klineData.x,
		quoteAssetVolume: parseFloat(klineData.q),
		baseAssetVolume: parseFloat(klineData.V),
		timestamp: klineData.T
	});

	// Update the high and low price objects for the Kline's time interval
	const intervalIndex = intervals.findIndex((interval) => interval === klineData.i);
	if (intervalIndex !== -1) {
		const highPrice = highPrices[klineData.i];
		const lowPrice = lowPrices[klineData.i];
		if (klineData.h > highPrice) {
			highPrices[klineData.i] = klineData.h;
		}
		if (klineData.l < lowPrice) {
			lowPrices[klineData.i] = klineData.l;
		}
	}

	// Publish the Kline object to RabbitMQ
	rabbit.sendQueue(env.wsBinance, Buffer.from(JSON.stringify(klineObject)), 0, 300,(err) => {
		if (err) {
			failK++;
			logger.error(err);
		}
		succK++;
	});

	// Publish the Kline object to Redis
	const channelName = `kline:${klineData.s}:${klineData.i}:binance`;
	const scoreValue = JSON.stringify(klineObject);
	const cutoff = Date.now() - 60 * 60 * 1000;

	redis.pub
		.multi()
		.zadd(channelName, klineData.T, scoreValue)
		.zremrangebyscore(channelName, 0, cutoff)
		.exec()
		.then()
		.catch((err) => {
			logger.error(`Error processing kline: ${err.message}`);
			throw err;
		});
}

module.exports = {
    webSocket: {
        connect,
        disconnect,
        subscribe,
        unsubscribe,
        disconnectAll,
        // Check if a WebSocket connection is already established for the specified symbol
        isSubscribed(symbol) {
            for (const key of Object.keys(wsConnections)) {
                if (key.startsWith(symbol)) {
                    return true;
                }
            }
            return false;
        }
    },
    processTrade,
    processKline,
    handleMessage
};