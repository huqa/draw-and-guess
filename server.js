/*
 * Piirrä & arvaa - nodejs server
 * @author Ville Riikonen // huqa - pikkuhukka@gmail.com
 *
 * TODO: 
 *
 *
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

// Create empty db
db.serialize(function() {
	if(!db_file_exists) {
		db.run('CREATE TABLE words(id int PRIMARY KEY, word TEXT)');
		// Possibly create scores
	}
});
db.close();

// All usernames participating
var usernames = {};

// All users wanting to play
var players = {};
// scorelist
var score = {};

// Simple queue implementation
// TODO a real queue with sorting --
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
//route for jquery -- i guess we need to do this for all external js-files
//app.get('/jquery.js', function(req, res) {
//	res.sendfile(__dirname + '/js/lib/jquery.js');
//});
app.use(express.static(__dirname + '/js/lib'));
app.use(express.static(__dirname + '/img'));
app.use(express.static(__dirname + '/css'));

var game = new function() {
	this.max_time = 180;
	this.intermission_time = 15;
	// The game is running (includes intermissions etc.)
	this.is_running = false;
	// Is the game in intermission
	this.is_intermission = false;
	// Is the drawer currently drawing
	this.player_is_drawing = false;
	this.drawer = "";
	this.timer;
	this.the_word = "nabuti";
	this.start_timer = function() {
		this.player_is_drawing = true;
		io.sockets.emit('drawer_counter_start');
		counter = this.max_time;
		this.timer = setInterval(this.decrement, 1000);
	};
	this.stop_timer = function() {
		clearInterval(this.timer);
		counter = 0;
		//update the client side as well
	};
	this.start_intermission = function() {
		// here we should broadcast the word to be guessed for the drawer - oh ja se pitää arpoo
		var id = find_socket_by_name(this.drawer);
		//sqlite fetch here
		io.sockets.sockets[id].emit('word_to_draw', this.the_word);
		io.sockets.emit('intermission_counter_start');
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
			var id = find_socket_by_name(this.drawer);
			io.sockets.sockets[id].is_drawer = false;	
			io.sockets.sockets[id].emit('is_drawing', false);
		} else {
			io.sockets.emit('counter', counter);
		}
	};
	this.intermission_decrement = function(self) {
		counter = counter - 1;
		if(counter <= 0) {
			game.stop_timer();
			io.sockets.emit('intermission_counter_stop');
			this.is_intermission = false;
			game.start_timer();
		} else {
			io.sockets.emit('counter', counter);
		}
	};
	this.run = function() {
		this.is_running = true;
		this.drawer = player_queue();
		// here we should change the socket session variable .is_drawer
		var id = find_socket_by_name(this.drawer);
		//console.log(id);
		//console.log(io.sockets.sockets);
		io.sockets.sockets[id].is_drawer = true;
		io.sockets.sockets[id].emit('is_drawing', true);
		io.sockets.sockets[id].emit('update_chat', 'SERVER', "It's your turn to draw.");
		io.sockets.emit('game_start');
		this.start_intermission();
	};
	this.stop = function() {
		var id = find_socket_by_name(this.drawer);
		io.sockets.sockets[id].is_drawer = false;
		io.sockets.sockets[id].emit('is_drawing', false);
		this.is_running = false;
		this.is_intermission = false;
		this.player_is_drawing = false;
		this.drawer = "";
		this.the_word = "";
		this.stop_timer();
		player_queue = queue();
		io.sockets.emit('game_stop');
	};
	this.guessed_right = function() {
		this.player_is_drawing = false;
		this.the_word = "";
		this.stop_timer();
		var id = find_socket_by_name(this.drawer);
		io.sockets.sockets[id].is_drawer = false;
		io.sockets.sockets[id].emit('is_drawing', false);
		// intermission, new word, next drawer
		this.next_drawer();
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
		io.sockets.sockets[id].emit('update_chat', 'SERVER', "It's your turn to draw.");		
		io.sockets.emit('next_drawer');
		this.start_intermission();
	};
	this.is_drawer = function(player) {
		if (this.drawer === player) {
			return true;
		} else {
			return false;
		}
	};
};

io.on('connection', function(socket){

	socket.is_drawer = false;
	// when the client emits 'msg', this listens and executes
	socket.on('msg', function (data) {
		// check if the word to guess -- i guess
		io.sockets.emit('update_chat', socket.username, data);
		if(game.the_word === data && !game.is_drawer(socket.username) && game.player_is_drawing === true) {
			// guessed the word yo
			io.sockets.emit('update_chat', 'SERVER', socket.username + ' was correct!');
			game.guessed_right();
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
		// echo to client they've connected
		socket.emit('update_chat', 'SERVER', 'you have connected');
		// echo globally (all clients) that a person has connected
		socket.broadcast.emit('update_chat', 'SERVER', username + ' has connected.');
		// update the list of users in chat, client-side
		io.sockets.emit('update_users', usernames);
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
				io.sockets.emit('update_chat', 'SERVER', 'GAME INIT::');
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
				if (players.length <= 1) {
					game_is_running = false;
					game.stop();
				}		
			} else {
				delete players[socket.username];
				rebuildqueue();
				if (players.length <= 1) {
					game_is_running = false;
					game.stop();
				}
			}
			socket.broadcast.emit('update_chat', 'SERVER', socket.username + ' is not playing.');
		}
	});
	
	// when the user disconnects.. perform this
	socket.on('disconnect', function(){
		// remove the username from global usernames list
		delete usernames[socket.username];
		// remove user from players
		if (players[socket.username] !== undefined) {
			delete players[socket.username];
		}
		// update list of users in chat, client-side
		io.sockets.emit('update_users', usernames);
		// echo globally that this client has left
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

