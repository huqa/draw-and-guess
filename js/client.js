	var socket = io.connect('http://mauku.net:8080');
	var is_my_turn = false;
	var is_intermission = false;
	var the_word = "";

	var painter = null;

	var _MSGS = {
		intermission: '>>> Intermission >>>',
		roundStart: '>>> Round start >>>',
		yourWord: '>>> Your word to draw next is: ',
		name: 'Welcome to draw and guess! Whats your name?'
	};

	// on connection to server, ask for user's name with an anonymous callback
	socket.on('connect', function(){
		// call the server-side function 'adduser' and send one parameter (value of prompt)
		// TODO clear UI
		var name = null;
		while(name === null || name === "") { name = prompt(_MSGS.name); }
		socket.emit('add_user', name);
		handleDrawingBoard();
		handleChat();
	});

	// listener, whenever the server emits 'updatechat', this updates the chat body
	socket.on('update_chat', function (username, data) {
		say(username, data);
	});

	// listener, whenever the server emits 'update_users', this updates the username list
	socket.on('update_users', function(data) {
		$('#users').empty();
		$.each(data, function(key, value) {
			$('#users').append('<div>' + key + '</div>');
		});
	});
	
	//on img update
	socket.on('update_img', function() {
		if (is_my_turn === false && painter !== null) {
	    	var src = 'out.png?' + new Date().getTime(); // Set source path 
	    	//console.log(src);
	    	//img.onload = function(){  
	      	// execute drawImage statements here  This is essential as it waits till image is loaded before drawing it.
	 	painter.setImg(src);
	    	//};
		}
	});
	// sets the word to draw for the drawer
	socket.on('word_to_draw', function(word) {
		the_word = word;
	});
	// counter, game_start, game_stop, next_drawer, intermission_counter_s/s, drawer_counter_s/s
	socket.on('game_start', function() {
		handleDrawingBoard();
		handleChat();
	});
	socket.on('game_stop', function() {
		handleDrawingBoard();
		handleChat();
		// CLEAR things if game is stopped. f.ex all buttons should be set to Wanna play
		$('#iwannaplay').prop('value', 'iwannaplay');
		$('#iwannaplay').html("I wanna play");
		painter.resetBackground();

	});	
	socket.on('is_drawing', function(what) {
		is_my_turn = what;
	});

	socket.on('intermission_counter_start', function() {
		is_intermission = true;
		painter.resetBackground();
		handleDrawingBoard();
		handleChat();
		console.log(socket);
		//var message = '<div class="message"><b>INTERMISSION::</b></div>';
		var message = bold_msg(_MSGS.intermission);
		server_say(message);
		if(is_my_turn === true) {
			//var msg = '<div class="message"><b>!!!! YOUR WORD is </b> ' + the_word + '<br></div>';
		        var msg = _MSGS.yourWord + the_word + '>>>';
			msg = bold_msg(msg); 
			server_say(msg);
			$('#word').html(the_word);
		} else {
			the_word = "";
			$('#word').html("");
		}
	});

	socket.on('intermission_counter_stop', function() {
		is_intermission = false;
		handleDrawingBoard();
	});
	
	socket.on('drawer_counter_start', function() {
		//var msg = '<div class="message"><b>ROUND START::</b><br></div>';
		var msg = bold_msg(_MSGS.roundStart);
		server_say(msg);
	});
	
	socket.on('counter', function(count) {
		$('#counter').html(count);
	});
	
	function handleDrawingBoard() {
		if(is_my_turn === true && is_intermission === false) {
			$(".drawing-board-canvas").css('pointer-events', 'auto');
		} else {
			$(".drawing-board-canvas").css('pointer-events', 'none');
		}
	}

	function handleChat() {
		if(is_my_turn === true) {
			disable_chat();
		} else {
			enable_chat();
		}
	}

	function say(username, data) {
		//var out = '<div class="message"><b>'+ username +'</b> ' + data + '<br></div>';
		var out = say_msg(username, data);
		$('#conversation').append(out);
		$('#conversation').scrollTop($('#conversation')[0].scrollHeight);		
	}

	function server_say(data) {
		$('#conversation').append(data);
		$('#conversation').scrollTop($('#conversation')[0].scrollHeight);		
	}
	
	function enable_chat() {
		$('#data').prop('disabled', false);
		$('#datasend').prop('disabled', false);		
	}
	
	function disable_chat() {
		$('#data').prop('disabled', true);
		$('#datasend').prop('disabled', true);		
	}

	/** Decorates a message with say-markup */
	function say_msg(username, data) {
		return '<div class="message"><b>'+ username +'</b> ' + data + '<br></div>';
	}
	/** Decorates a message with default markup */
	function default_msg(data) {
		return '<div class="message">'+data+'<br></div>';
	}

	function bold_msg(data) {
		return '<div class="message"><b>'+data+'</b><br></div>';
	}

	// on page load
	$(function(){
		
		// when the client clicks SEND
		$('#datasend').click( function() {
			var message = $('#data').val();
			$('#data').val('');
			socket.emit('msg', message);
		});

		$('#iwannaplay').click(function() {
			if($(this).prop('value') === 'iwannaplay') {
				socket.emit('wanna_play', true);
				$(this).prop('value', 'dontwanna');
				$(this).html("I don't wanna play");
			} else {
				socket.emit('wanna_play', false);
				$(this).prop('value', 'iwannaplay');
				$(this).html("I wanna play");
			}
			handleDrawingBoard();
			handleChat();
		});
		
		// when the client hits ENTER on their keyboard
		$('#data').keypress(function(e) {
			if(e.which == 13) {
				$(this).blur();
				$('#datasend').focus().click();
				$('#data').focus();
			}
		});

		painter = new DrawingBoard.Board('painter', {
			background: '#ffffff',
			size: 4,
			controls: [
				'Color',
				{ Size: { type: 'dropdown'} },
				'DrawingMode',
				'Navigation'
			],
			webStorage: false,
		});

		painter.ev.bind('board:stopDrawing', function() {
			if (is_my_turn === true) {
				var dataUrl = painter.getImg();
				socket.emit('img_send', dataUrl);
			}
		});

	});
