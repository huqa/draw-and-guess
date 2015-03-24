/*
 * draw-and-guess node server and game logic
 *
 * TODO:
 * 	tooltips
 * 	limit chat messages
 *
 * @author Ville Riikonen // huqa - pikkuhukka@gmail.com
 */

var password = "kulli";

var express = require('express'),
    http = require('http');

var app = express();
var server = http.createServer(app).listen(8080);

var io = require('socket.io').listen(server, {'log level': 1});

// Use basic http authentication
io.configure(function() {
	io.set('authorization', function(handshakeData, callback) {
		if(typeof handshakeData.headers.authorization === "undefined") {
			callback("No authorization header found!", false);
		} else {
			var authStr = handshakeData.headers.authorization.split(" ")[1];
			var namePw = new Buffer(authStr, 'base64').toString('utf8');
			handshakeData.username = namePw.split(":")[0]; 
			callback(null, true);
		}
	});
});

//filesystem and sqlite for words
var fs = require('fs');
var db_file = "pa.db";
var db_file_exists = fs.existsSync(db_file);

if(!db_file_exists) {
	console.log("Creating new database for draw-and-guess.");
	fs.openSync(db_file, "w");
}

var sqlite3 = require('sqlite3').verbose();
var db = new sqlite3.Database(db_file);

db.serialize(function() {
	if(!db_file_exists) {
		db.run('CREATE TABLE words(id int PRIMARY KEY, word TEXT, type TEXT)');
		db.run('INSERT INTO words(word, type) VALUES("bulle", "subs.")');		
	}
});
db.close();

// All usernames participating
var usernames = {};

// All users wanting to play
var players = {};
//// scorelist
var scores = {};

var DGQueue = new DGQueue();
var game_is_running = false;

var counter = 0;

//sync(DGQueue, "size", "enqueue", "dequeue", "remove", "_removeRecursive", 
  //  "hasNode", "findNode", "empty", "rebuildPositions", "_rebuild", "_syncQueue", "positions");
// Use basic http auth
app.use(express.basicAuth(function(user, pass) {
	return pass === password;
}));

//routing
app.get('/', function (req, res) {
  res.sendfile(__dirname + '/index.html');
});

app.use(express.static(__dirname + '/js'));
app.use(express.static(__dirname + '/js/lib'));
app.use(express.static(__dirname + '/img'));
app.use(express.static(__dirname + '/css'));

var game = new function() {
	this.max_time = 120;
	this.intermission_time = 15;
	this.victory_timer = 10;
	// The game is running (includes intermissions etc.)
	this.is_running = false;
	// Is the game in intermission
	//this.is_intermission = false;
	//this.is_cooldown = false;
	// Is the drawer currently drawing
	//this.player_is_drawing = false;
	this.drawer = "";
	this.timer;
	this.the_word = "";
	this.the_word_data = {};
	this.phase = {
		'cooldown': false,
		'intermission': false,
		'dag': false
	};
	this.set_phase = function(phase, value) {
		if(this.phase.hasOwnProperty(phase)) {
			value = typeof value !== "undefined" ? value : true;
			for(var p in this.phase) {
				this.phase[p] = false;
				if(p === phase) {
					this.phase[p] = value;
				}
			}
		}
	};
	this.get_phase = function() {
		for(var phase in this.phase) {
			if(this.phase[phase] === true) {
				return phase;
			}
		}
	};
	this.start_timer = function() {
		//this.player_is_drawing = true;
		this.set_phase('dag', true);
		io.sockets.emit('drawer_counter_start');
		counter = this.max_time;
		this.timer = setInterval(this.decrement, 1000);
	};
	this.stop_timer = function() {
		clearInterval(this.timer);
		counter = 0;
	};
	this.start_intermission = function() {
		var id = this.drawer;
		//this.fetch_word();
		io.sockets.sockets[id].emit('word_to_draw', this.the_word);
		io.sockets.emit('intermission_counter_start');
		io.sockets.emit('drawer', find_name_by_id(this.drawer));
		io.sockets.emit('word_data', this.the_word_data);
		//this.is_intermission = true;
		//this.player_is_drawing = false;
		this.set_phase('intermission', true);
		counter = this.intermission_time;
		this.timer = setInterval(this.intermission_decrement, 1000);
	};
	this.decrement = function(self) {
		counter = counter - 1;
		if(counter <= 0) {
			game.stop_timer();
			//game.player_is_drawing = false;
			game.set_phase('dag', false);
			io.sockets.emit('drawer_counter_stop');
			var id = game.drawer;
			io.sockets.sockets[id].is_drawer = false;
			io.sockets.sockets[id].emit('is_drawing', false);
			// No one guessed the word so show the word and next drawer?
			io.sockets.emit('update_chat', 'SERVER', 'No one guessed the word: <b>' + game.the_word + '</b>');
                	io.sockets.emit('victory_counter_start');
		        counter = game.victory_timer;
			game.timer = setInterval(game.victory_decrement, 1000);

		} else {
			io.sockets.emit('counter', counter);
			if(counter == 60) {
				io.sockets.emit('reveal_first_letter', game.the_word[0]);
			} else if(counter == 30) {
				io.sockets.emit('reveal_last_letter', game.the_word[game.the_word.length-1]);
			}
		}
	};
	this.intermission_decrement = function(self) {
		counter = counter - 1;
		if(counter <= 0) {
			game.stop_timer();
			io.sockets.emit('intermission_counter_stop');
			//game.is_intermission = false;
			game.set_phase('intermission', false);
			game.start_timer();
		} else {
			io.sockets.emit('counter', counter);
		}
	};
	this.victory_decrement = function(self) {
		counter = counter - 1;
		if(counter <= 0) {
			game.stop_timer();
			io.sockets.emit('victory_counter_stop');
			//game.is_cooldown = false;
			game.set_phase('cooldown', false);
			game.next_drawer();
		} else {
			io.sockets.emit('counter', counter);
		}
	};
	this.run = function() {
		this.is_running = true;
		//this.drawer = player_queue();
		this.drawer = DGQueue.dequeue();
		DGQueue.rebuildPositions(io.sockets.sockets);
		io.sockets.emit('update_users', usernames, scores, DGQueue.positions());
		// here we should change the socket session variable .is_drawer
		var id = this.drawer;
		if(socket_exists(id)) {
			io.sockets.sockets[id].is_drawer = true;
			io.sockets.sockets[id].emit('is_drawing', true);
			io.sockets.sockets[id].emit('update_chat', 'SERVER', "It's your turn to draw.");
		}
		io.sockets.emit('game_start');
		//this.start_intermission();
		this.fetch_word_and_start_intermission();
	};
	this.stop = function(is_reset) {
		var id = this.drawer;
		if(socket_exists(id)) {
			io.sockets.sockets[id].is_drawer = false;
			io.sockets.sockets[id].emit('is_drawing', false);
		}
		this.is_running = false;
		//this.is_intermission = false;
		//this.player_is_drawing = false;
		//this.is_cooldown = false;
		this.set_phase('dag', false);
		this.drawer = "";
		this.the_word = "";
		this.the_word_type = "";
		this.stop_timer();
		io.sockets.emit('update_users', usernames, scores, DGQueue.positions());
		if(is_reset === false) {
			io.sockets.emit('game_stop');
		} else {
			io.sockets.emit('game_reset');
		}
	};
	this.guessed_right = function(guesser) {
		var score_count = counter;
		//this.player_is_drawing = false;
		this.set_phase('dag', false);
		this.the_word = "";
		this.the_word_type = "";
		this.stop_timer();
		var id = this.drawer;
		// Drawer gets 5 percent bonus
		scores[this.drawer] += score_count + Math.floor(score_count * 0.05);
		scores[guesser] += score_count;
		io.sockets.sockets[id].is_drawer = false;
		io.sockets.sockets[id].emit('is_drawing', false);
		io.sockets.emit('update_users', usernames, scores, DGQueue.positions());
		io.sockets.emit('victory_counter_start');
		//this.is_cooldown = true;
		this.set_phase('cooldown', true);
		counter = this.victory_timer;
		this.timer = setInterval(this.victory_decrement, 1000);
		// intermission, new word, next drawer
		//this.next_drawer();
	};
	this.set_drawer = function(player) {
		this.drawer = player;
	};
	this.next_drawer = function() {
		var id = this.drawer;
		if(socket_exists(id)) {
			io.sockets.sockets[id].is_drawer = false;
			io.sockets.sockets[id].emit('is_drawing', false);
		}
		//player_queue(this.drawer);
		DGQueue.enqueue(this.drawer);
		this.drawer = DGQueue.dequeue();
		DGQueue.rebuildPositions(io.sockets.sockets);
		io.sockets.emit('update_users', usernames, scores, DGQueue.positions());
		id = this.drawer;
		io.sockets.sockets[id].is_drawer = true;
		io.sockets.sockets[id].emit('is_drawing', true);
		io.sockets.sockets[id].emit('update_chat', 'SERVER', "It's your turn to draw next.");
		io.sockets.emit('next_drawer');
		this.fetch_word_and_start_intermission();
	};
	this.is_drawer = function(player) {
		if (game.drawer === player) {
			return true;
		} else {
			return false;
		}
	};
	this.fetch_word_and_start_intermission = function() {
        	db = new sqlite3.Database(db_file);
	        db.serialize(function() {
			db.get("SELECT * FROM words ORDER BY RANDOM() LIMIT 1", function(error, row) {
				if(typeof row !== "undefined") { 
					game.the_word = row.word;
					game.the_word_data.type = row.type;
					game.the_word_data.word_length = row.word.length;
					if(row.word.indexOf(' ') >= 0) {
						game.the_word_data.has_whitespace = true;
						game.the_word_data.whitespace_index = row.word.indexOf(' ');
					} else {
						game.the_word_data.has_whitespace = false;
					}
				}
				game.start_intermission();	
			});
		});
		db.close();
	};
	this.send_status_to_sockets = function() {
		io.sockets.emit('update_users', usernames, scores, DGQueue.positions());
		io.sockets.emit('drawer', find_name_by_id(this.drawer));
		io.sockets.emit('word_data', this.the_word_data);
		io.sockets.emit('phase', this.get_phase());
	};

};

io.on('connection', function(socket){

	socket.is_drawer = false;
	// when the client emits 'msg', this listens and executes
	socket.on('msg', function (data) {
		// check if the word to guess -- i guess
		io.sockets.emit('update_chat', socket.username, data);
		var phase = game.get_phase();
		if(game.the_word.toLowerCase() === data.toLowerCase() && DGQueue.hasNode(socket.id) && !game.is_drawer(socket.id) && phase === 'dag') {
			// guessed the word yo
			io.sockets.emit('update_chat', 'SERVER', socket.username + ' was correct! The word was <b>' + data + '</b>');
			game.guessed_right(socket.id);
		}
		if(game.the_word.toLowerCase().indexOf(data.toLowerCase()) !== -1 && DGQueue.hasNode(socket.id) && phase === 'dag') {
			io.sockets.emit('update_chat', 'SERVER', socket.username + ' guessed partially correct with ' + data);
		}
	});
	// when the client sends an image
	socket.on('img_send', function (img_data) {
		// BASE_64 save to file or send straight to clients?
		var base64Data = img_data.replace(/^data:image\/png;base64,/,"");
		require("fs").writeFile(__dirname + "/img/out.png", base64Data, 'base64', function(err) {
			socket.broadcast.emit('update_img');
		});
	});
	
	// when the client emits 'add_user', this listens and executes
	socket.on('add_user', function(){
		var username = socket.handshake.username;
		// lets store an internal is_drawer-variable 
		socket.is_drawer = false;
		// we store the username in the socket session for this client
		socket.username = username;
		// add the client's username to the global list
		usernames[socket.id] = username;
		// Scores too
		scores[socket.id] = 0;
		console.log(socket.id + " " + socket.username + " connected to server.");
		// echo to client they've connected
		socket.emit('update_chat', 'SERVER', 'Welcome ' + username + ' to draw-and-guess!');
		// echo globally (all clients) that a person has connected
		socket.broadcast.emit('update_chat', 'SERVER', username + ' has connected!');
		// update the list of users in chat, client-side
		io.sockets.emit('update_users', usernames, scores, DGQueue.positions());
		socket.is_drawer = false;
	});

	socket.on('wanna_play', function(want_to_play){
		// set does the user wanna play
		socket.wanna_play = want_to_play;
		if(want_to_play === true) {
			if(!DGQueue.hasNode(socket.id)) {
				DGQueue.enqueue(socket.id);
				DGQueue.rebuildPositions(io.sockets.sockets);
				//console.log(DGQueue);
				io.sockets.emit('update_users', usernames, scores, DGQueue.positions());
				if (DGQueue.size() >= 2 && game.is_running === false) {
					io.sockets.emit('update_chat', 'SERVER', 'The game is starting soon.');
					game.run();
				}
			}
		} else {
			socket.broadcast.emit('update_chat', 'SERVER', socket.username + ' is not playing.');
			DGQueue.remove(socket.id);
			DGQueue.rebuildPositions(io.sockets.sockets);
			var phase = game.get_phase();
			if(game.is_drawer(socket.id) && (phase === 'dag' || phase === 'intermission')) {
				if(DGQueue.size() >= 2) {
					game.stop(true);
					game.run();
				} else {
					game.stop(false);
				}
			}
			if(!game.is_drawer(socket.id) && game.drawer != "") {
				if(DGQueue.size() <= 0) {
					game.stop(false);
				} 
			}
			io.sockets.emit('update_users', usernames, scores, DGQueue.positions());
			//console.log(DGQueue.positions());
		}
	});
	
	// when the user disconnects.. perform this
	socket.on('disconnect', function() {

		console.log(socket.id + " " + socket.username + " disconnected from server.");
		DGQueue.remove(socket.id);
		DGQueue.rebuildPositions(io.sockets.sockets);
		delete usernames[socket.id];
		delete scores[socket.id];
		if(game.is_drawer(socket.id)) {
			if(DGQueue.size() >= 2 && (phase === 'dag' || phase === 'intermission')) {
				game.stop(true);
				game.run();
			} else {
				game.stop(false);
			}
		} else {
			if(DGQueue.size() <= 1) {
				game.stop(false);
			}
		}
		
		socket.broadcast.emit('update_chat', 'SERVER', socket.username + ' has disconnected');

	});
	
});

// Fetches a socket with a players name
function find_socket_by_name(name) {
	var all_sockets = io.sockets.sockets;
	for(s in all_sockets) {
		if(all_sockets[s].username === name) {
			return all_sockets[s].id;
		}
	}
	return undefined;
}

function find_name_by_id(id) {
	var all_sockets = io.sockets.sockets;
	for(var s in all_sockets) {
		if(all_sockets[s].id === id) {
			return all_sockets[s].username;
		}
	}
	return undefined;
}

function socket_exists(id) {
	var all_sockets = io.sockets.sockets;
	for(var s in all_sockets) {
		if(all_sockets[s].id === id) {
			return true;
		}
	}
	return false;
}

/**
 * Player node for the queue data structure.
 */
function PNode(id) {
	this.id = id;
	this.prev = undefined;
	this.next = undefined;
}

/**
 * Simple queue data structure
 * Implemented with a doubly-linked list
 */
function DGQueue() {
	this.count = 0;
	this.first = undefined;
	this.last = undefined;
	this.nodes = {};

	/**
	 * Returns size of queue
	 */
	this.size = function() {
		return this.count;
	};

	/**
	 * Enqueues node
	 */
	this.enqueue = function(id) {
		this.old_last = this.last;
		this.last = new PNode(id);
		if(this.empty()) {
			this.first = this.last;
		} else {
			this.old_last.next = this.last;
			this.last.prev = this.old_last;
		}
		this.count++;
	};

	/**
	 * Returns the first node
	 */
	this.dequeue = function() {
		var node = this.first;
		this.first = node.next;
		this.first.prev = undefined;
		node.next = undefined;
		node.prev = undefined;
		this.count--;
		return node.id;
	};

	this.remove = function(value) {
		var node = this.first;
		if(typeof node === "undefined") {
			return undefined;
		}
		return this._removeRecursive(node, value);
	};

	this._removeRecursive = function(node, value) {
		var prev_n = node.prev;
		var next_n = node.next;
		if(node.id === value) {
			if(typeof prev_n !== "undefined") {
				prev_n.next = next_n;
			} else {
				this.first = next_n;
				if(typeof next_n !== "undefined") {
					next_n.prev = undefined;
				}
			}
			if (typeof next_n !== "undefined") {
				next_n.prev = prev_n;
			} else {
				this.last = prev_n;
				if(typeof prev_n !== "undefined") {
					prev_n.next = undefined;
				}
			}
			this.count--;
			node.next = undefined;
			node.prev = undefined;
			return node.id;
		} else {
			if(typeof next_n !== "undefined") {
				return this._removeRecursive(next_n, value);
			} else {
				return undefined;
			}
		}
	};

	/**
	 * Checks if the player has registered from the position list.
	 * Does not loop through the list.
	 */
	this.hasNode = function(data) {
                var node = this.first;
                if(typeof node === "undefined") {
                        return false;
                }
                do {
                        if(node.id === data) {
				return true;
			}
                        node = node.next;
                } while(typeof node !== "undefined");
		return false;
	};

	this.findNode = function(data) {
        	var node = this.first;
		if(typeof node === "undefined") {
			return undefined;
		}
		do {
			if(node.id === data) {
				return node;
			}
			node = node.next;
		} while(typeof node !== "undefined");
		return undefined;
	};

	/**
	 * Is queue empty?
	 */
	this.empty = function() {
		return typeof this.first === "undefined";
	};
	
	/**
	 * Rebuilds queue
	 */
	this.rebuildPositions = function(sockets) {
		this._syncQueue(sockets);
		this._rebuild();
	};

	this._rebuild = function() {
		var node = this.first;
		if(typeof node === "undefined") {
			return false;
		}
		this.nodes = {};
		for(var i = 0; i < this.count; i++) {
			this.nodes[node.id] = i+1;
			node = node.next;
		}
	};
	/**
	 * syncs queue with socket list
	 */
	this._syncQueue = function(sockets) {
		var node = this.first;
		for(var i = 0; i < this.count; i++) {
			var found = false;
			if(typeof node !== "undefined") {
				for(var socket in sockets) {
					if(sockets[socket].id === node.id) {
						found = true;
					}
				}
				node = node.next;
			}
			if(found === false) {
				node = node.next;
				this.remove(node.id);
			}
		}
	};

	this.positions = function() {
		return this.nodes;
	};
}

