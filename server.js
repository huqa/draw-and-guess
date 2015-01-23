/*
 * draw-and-guess node server and game logic
 *
 * TODO: send note of white space in word to clients
 *
 * @author Ville Riikonen // huqa - pikkuhukka@gmail.com
 */


var express = require('express'),
    http = require('http');

var app = express();
var server = http.createServer(app).listen(8080);

var io = require('socket.io').listen(server);

//filesystem and sqlite for words
var fs = require('fs');
var db_file = "pa.db";
var db_file_exists = fs.existsSync(db_file);

if(!db_file_exists) {
	console.log("Creating new database for piirra&arvaa.");
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
// scorelist
var scores = {};

// Simple queue implementation
// TODO a real queue
function queue(){var a,b,c,d;return d=function(e){e!=c?(b=b?b.n={v:e}:a={v:e},e=d):(e=a?a.v:c,a=a==b?b=c:a.n);return e}}
var player_queue = queue();
// Adds player to the queue
function addtoqueue(player) {
	player_queue(player);
}
// rebuilds queue if queue changed
function rebuildqueue() {
	player_queue = queue();
	for(p in players) {
		player_queue(p);
	}
}


var game_is_running = false;

var counter = 0;


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
	this.victory_timer = 8;
	// The game is running (includes intermissions etc.)
	this.is_running = false;
	// Is the game in intermission
	this.is_intermission = false;
	this.is_cooldown = false;
	// Is the drawer currently drawing
	this.player_is_drawing = false;
	this.drawer = "";
	this.timer;
	this.the_word = "";
	this.the_word_data = {};
	this.start_timer = function() {
		this.player_is_drawing = true;
		io.sockets.emit('drawer_counter_start');
		counter = this.max_time;
		this.timer = setInterval(this.decrement, 1000);
	};
	this.stop_timer = function() {
		clearInterval(this.timer);
		counter = 0;
	};
	this.start_intermission = function() {
		var id = find_socket_by_name(this.drawer);
		//this.fetch_word();
		io.sockets.sockets[id].emit('word_to_draw', this.the_word);
		io.sockets.emit('intermission_counter_start');
		io.sockets.emit('drawer', this.drawer);
		io.sockets.emit('word_data', this.the_word_data);
		this.is_intermission = true;
		this.player_is_drawing = false;
		counter = this.intermission_time;
		this.timer = setInterval(this.intermission_decrement, 1000);
	};
	this.decrement = function(self) {
		counter = counter - 1;
		if(counter <= 0) {
			game.stop_timer();
			io.sockets.emit('drawer_counter_stop');
			var id = find_socket_by_name(game.drawer);
			io.sockets.sockets[id].is_drawer = false;
			io.sockets.sockets[id].emit('is_drawing', false);
			// No one guessed the word so show the word and next drawer?
			io.sockets.emit('update_chat', 'SERVER', 'No one guessed the word: ' + game.the_word);
                	io.sockets.emit('victory_counter_start');
		        counter = game.victory_timer;
			game.timer = setInterval(game.victory_decrement, 1000);

		} else {
			io.sockets.emit('counter', counter);
			if(counter == 90) {
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
			game.is_intermission = false;
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
			game.is_cooldown = false;
			game.next_drawer();
		} else {
			io.sockets.emit('counter', counter);
		}
	};
	this.run = function() {
		this.is_running = true;
		this.drawer = player_queue();
		// here we should change the socket session variable .is_drawer
		var id = find_socket_by_name(this.drawer);
		io.sockets.sockets[id].is_drawer = true;
		io.sockets.sockets[id].emit('is_drawing', true);
		io.sockets.sockets[id].emit('update_chat', 'SERVER', "It's your turn to draw.");
		io.sockets.emit('game_start');
		//this.start_intermission();
		this.fetch_word_and_start_intermission();
	};
	this.stop = function() {
		var id = find_socket_by_name(this.drawer);
		if(typeof id !== "undefined") {
			io.sockets.sockets[id].is_drawer = false;
			io.sockets.sockets[id].emit('is_drawing', false);
		}
		this.is_running = false;
		this.is_intermission = false;
		this.player_is_drawing = false;
		this.drawer = "";
		this.the_word = "";
		this.the_word_type = "";
		this.stop_timer();
		player_queue = queue();
		rebuildqueue();
		io.sockets.emit('game_stop');
	};
	this.guessed_right = function(guesser) {
		var score_count = counter;
		this.player_is_drawing = false;
		this.the_word = "";
		this.the_word_type = "";
		this.stop_timer();
		var id = find_socket_by_name(this.drawer);
		// Drawer gets 5 percent bonus
		scores[this.drawer] += score_count + Math.floor(score_count * 0.05);
		scores[guesser] += score_count;
		io.sockets.sockets[id].is_drawer = false;
		io.sockets.sockets[id].emit('is_drawing', false);
		io.sockets.emit('update_users', usernames, scores);
		io.sockets.emit('victory_counter_start');
		this.is_cooldown = true;
		counter = this.victory_timer;
		this.timer = setInterval(this.victory_decrement, 1000);
		// intermission, new word, next drawer
		//this.next_drawer();
	};
	this.set_drawer = function(player) {
		this.drawer = player;
	};
	this.next_drawer = function() {
		var id = find_socket_by_name(this.drawer);
		io.sockets.sockets[id].is_drawer = false;
		io.sockets.sockets[id].emit('is_drawing', false);
		player_queue(this.drawer);
		this.drawer = player_queue();
		id = find_socket_by_name(this.drawer);
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
};

io.on('connection', function(socket){

	socket.is_drawer = false;
	// when the client emits 'msg', this listens and executes
	socket.on('msg', function (data) {
		// check if the word to guess -- i guess
		io.sockets.emit('update_chat', socket.username, data);
		if(game.the_word.toLowerCase() === data.toLowerCase() && !game.is_drawer(socket.username) && game.player_is_drawing === true) {
			// guessed the word yo
			io.sockets.emit('update_chat', 'SERVER', socket.username + ' was correct!');
			game.guessed_right(socket.username);
		}
	});
	// when the client sends an image
	socket.on('img_send', function (img_data) {
		// BASE_64 save to file or send straight to clients?
		//console.log("SERVER got a kick ass image in BASE64");
		var base64Data = img_data.replace(/^data:image\/png;base64,/,"");
		require("fs").writeFile(__dirname + "/img/out.png", base64Data, 'base64', function(err) {
			socket.broadcast.emit('update_img');
		  //console.log(err);
		});
	});
	
	// when the client emits 'add_user', this listens and executes
	socket.on('add_user', function(username){
		// lets store an internal is_drawer-variable 
		socket.is_drawer = false;
		// we store the username in the socket session for this client
		socket.username = username;
		// add the client's username to the global list
		usernames[username] = username;
		// Scores too
		scores[username] = 0;
		// echo to client they've connected
		socket.emit('update_chat', 'SERVER', 'Welcome ' + username + '! You have connected succesfully!');
		// echo globally (all clients) that a person has connected
		socket.broadcast.emit('update_chat', 'SERVER', username + ' has connected.');
		console.log(usernames);
		// update the list of users in chat, client-side
		io.sockets.emit('update_users', usernames, scores);
		socket.is_drawer = false;
	});

	socket.on('wanna_play', function(want_to_play){
		// set does the user wanna play
		socket.wanna_play = want_to_play;
		if (want_to_play === true) {
			players[socket.username] = socket.username;
			io.sockets.emit('update_chat', 'SERVER', socket.username + ' is playing.');
			addtoqueue(socket.username);
			//console.log(game);
			//console.log(players);
			// Auto-start game for the debug sessions
			if (Object.keys(players).length >= 2 && game.is_running === false) {
				game.run();
				io.sockets.emit('update_chat', 'SERVER', 'The game is starting soon.');
				io.sockets.emit('update_chat', 'SERVER', "It's " + game.drawer + "'s turn.");
			}
		} else if (want_to_play === false) {
			// make sure the player is not drawing
			if(game.is_drawer(socket.username)) {
				if(game.is_intermission === true) {
					// Game is in intermission
					game.stop_timer();
					io.sockets.emit('intermission_counter_stop');
					game.is_intermission = false;
					delete players[socket.username];
					rebuildqueue();	
				} else if (game.is_cooldown === true) {
					game.stop_timer();
					io.sockets.emit('victory_counter_stop');
					game.is_cooldown = false;
					delete players[socket.username];
					rebuildqueue();				
				} else {
					// The player is drawing
					game.stop_timer();
					io.sockets.emit('drawer_counter_stop');
					game.player_is_drawing = false;
					game.the_word = "";
					delete players[socket.username];
					rebuildqueue();

				}
				socket.is_drawer = false;
				socket.emit('is_drawing', false);		
				if (Object.keys(players).length <= 1) {
					game.is_running = false;
					game.stop();
				} else {
					game.stop();
					game.run();
				}
			} else {
				delete players[socket.username];
				rebuildqueue();
				console.log(players.length);
				if (Object.keys(players).length <= 1) {
					game.is_running = false;
					game.stop_timer();
					if(game.is_intermission === true) {
						io.sockets.emit('intermission_counter_stop');
					} else if(game.is_cooldown === true) {
						io.sockets.emit('victory_counter_stop');
					} else {
						io.sockets.emit('drawer_counter_stop');
					}
					game.the_word = "";
					game.stop();
				}
			}
			socket.broadcast.emit('update_chat', 'SERVER', socket.username + ' is not playing.');
		}
	});
	
	// when the user disconnects.. perform this
	socket.on('disconnect', function() {
		console.log('socket.disconnects');
		delete usernames[socket.username];
		delete scores[socket.username];
		if (typeof players[socket.username] !== "undefined") {
			delete players[socket.username];
		}
		rebuildqueue();
		if(game.is_drawer(socket.username)) {
			socket.is_drawer = false;
			socket.emit('is_drawing', false);
			if(game.is_intermission === true) {
				game.stop_timer();
				io.sockets.emit('intermission_counter_stop');
				game.is_intermission = false;
				game.stop();
				if(Object.keys(players).length > 1) {
					game.run();
				}
			} else if(game.is_cooldown === true) {
                                game.stop_timer();
				io.sockets.emit('victory_counter_stop');
				game.is_cooldown = false;
				game.stop();
				if(Object.keys(players).length > 1) {
					game.run();
				}
			} else {
				game.stop_timer();
				io.sockets.emit('drawer_counter_stop');
				game.player_is_drawing = false;
				game.the_word = "";
				//delete players[socket.username];
				game.stop();
				if(Object.keys(players).length > 1) {
					game.run();
				}
			}
		} else {
			if(Object.keys(players).length <= 1) {
				game.stop();
			}
		}

		// remove the username from global usernames list
		/*delete usernames[socket.username];
		delete scores[socket.username];
		// remove user from players
		if (typeof players[socket.username] !== "undefined") {
			delete players[socket.username];
		}*/
		// update list of users in chat, client-side
		io.sockets.emit('update_users', usernames, scores);
		// echo globally that this client has left
		socket.broadcast.emit('update_chat', 'SERVER', socket.username + ' has disconnected');
	});
	
});

io.on('disconnect', function(socket) {
       	console.log('io.disconnects io.disconnect');	
	delete usernames[socket.username];
	delete scores[socket.username];
	if (typeof players[socket.username] !== "undefined") {
		delete players[socket.username];
	}
	io.sockets.emit('update_users', usernames, scores);
	socket.broadcast.emit('update_chat', 'SERVER', socket.username + ' has disconnected');
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

