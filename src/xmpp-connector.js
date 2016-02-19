var ltx = require('ltx'),
    Client = require('node-xmpp-client');

// Helper function for debugging. Leave in even if not in use.
function logStanza(stanza) {
    console.log("Stanza", JSON.stringify(stanza, function (k, v) { if (k === 'parent') { return 'Circular'; } else { return v; } }, '\t'))
}

function XMPPConnector(bot, Route) {
    var self = this;

    // All connectors MUST store the bot.
    self.bot = bot;

    self.events = bot.events;
    self.Route = Route;

    self.keepAlive = undefined;

    self.user_nicks = {};

    bot.configLoader.ensure('xmpp_host', null, 'XMPP Server Hostname (blah.slack.com)');
    bot.configLoader.ensure('xmpp_conference_host', null, "Usually prepend 'conference.' to server hostname (conference.blah.slack.com)");
    bot.configLoader.ensure('xmpp_user', null, 'Bot Username');
    bot.configLoader.ensure('xmpp_resource', null, 'Resource - for some services, such as Slack, this must be the same as user');
    bot.configLoader.ensure('xmpp_password', null, null);
    bot.configLoader.ensure('xmpp_presence', 'The Angriest Bot', 'Bot status line');
    bot.configLoader.ensure('xmpp_rooms', [], 'List of rooms to join');
    bot.configLoader.ensure('xmpp_keepalive_interval', 30, 'How frequently to ping the server to keep connection.')

    // Create XMPP client
    self.client = new Client({
        jid : bot.config.xmpp_user + '@' + bot.config.xmpp_host + '/' + bot.config.xmpp_resource,
        password : bot.config.xmpp_password,
        host : bot.config.xmpp_host,
        reconnect : true
    });

    // Handle whenever we get a XML stanza from the server
    self.client.on('stanza', self.handleStanza.bind(self));

    // We've connected to the server
    self.client.on('online', self.onConnect.bind(self));

    // Various online/offline messages just for logging
    self.client.on('offline', function () {
        console.log('XMPP is offline');
    });

    self.client.on('connect', function () {
        console.log('XMPP is connected');
    });

    self.client.on('reconnect', function () {
        console.log('XMPP reconnects …');
    });

    self.client.on('disconnect', function (e) {
        console.log('XMPP is disconnected', self.client.connection.reconnect, e);
    });

    // Error logging
    self.client.on('error', function (e) {
        console.error(e);
    });

    // Shutdown XMPP connection when the bot shuts down
    self.events.on('shutdown', self.shutdown.bind(this));
}

XMPPConnector.prototype.onConnect = function () {
    console.log('XMPP is online');

    // Emit event for other modules
    this.events.emit('chat_connected', this);

    // Get user roster
    this.client.send(new ltx.Element('iq', {type: 'get'})
        .c('query', { xmlns: 'jabber:iq:roster'}));

    // Send own presence
    this.client.send(new ltx.Element('presence', { })
        .c('show').t('chat').up()
        .c('status').t(this.bot.config.xmpp_presence)
        .c('c', {
            xmlns: "http://jabber.org/protocol/caps",
            node: "http://hipchat.com/client/bot"})         // Recommended for hipchat, other providers will ignore this.
    );

    // Join rooms after initial roster is retrieved
    var rosterInterval;
    rosterInterval = setInterval(function (){
        if (this.user_nicks.length === 0) {
            console.log("Waiting for roster...");
            return;
        }
        console.log("Roster retrieved, joining rooms");
        // We have the roster, go ahead
        for (var i in this.bot.config.xmpp_rooms) {
            this.joinRoom(this.bot.config.xmpp_rooms[i]);
        }
        clearInterval(rosterInterval);
    }.bind(this), 1000);


    // Start keepalive
    this.keepAlive = setInterval(function () {
        this.client.send(new ltx.Element('r'));
    }.bind(this), this.bot.config.xmpp_keepalive_interval * 1000);
};

XMPPConnector.prototype.handleStanza = function (stanza) {
    // Handle inbound messages
    if (stanza.is('message')) {
        if (stanza.attrs.type === 'chat' || stanza.attrs.type === 'groupchat') {
            this.parseChat(stanza);
        }
        return;
    }

    // Handle pings
    if (stanza.is('iq') && stanza.attrs.type === 'get' && stanza.children[0].name === 'ping') {
        var pong = new ltx.Element('iq', {
            to : stanza.attrs.from,
            from : stanza.attrs.to,
            type : 'result',
            id : stanza.attrs.id
        });
        this.client.send(pong);
        return;
    }

    // Handle IQ request
    if (stanza.is('iq') && stanza.attrs.type === 'result' && stanza.children[0]) {
        var child = stanza.children[0];
        if (child.name === 'query' && child.attrs.xmlns === 'jabber:iq:roster') {
            var users = child.children;
            for (var i = 0; i < users.length; i++) {
                var info = users[i].attrs;
                var jid = info.jid.split('@')[0];
                var retrieved = this.bot.users.getOrCreateUser(jid, info.mention_name);
                this.user_nicks[info.name] = jid;
            }
        }
    }

    // Handle inbound presences
    if (stanza.is('presence')) {

        // Room presences
        if (stanza.getChild('x') && stanza.getChild('x').attrs.xmlns.indexOf('muc') > -1) {
            var user = stanza.attrs.from.split('/')[1];
            var room = stanza.attrs.from.split('@')[0];

            if (room && user && stanza.attrs.to !== this.bot.config.xmpp_user + '@' + this.bot.config.xmpp_host) {
                var jid = this.user_nicks[user];
                var route = new this.Route(this, room, jid);
                if (stanza.attrs.type === 'unavailable') {
                    this.bot.users.userLeavesRoom(route);
                } else {
                    this.bot.users.userEntersRoom(route);
                }
            }
        }
        // Other presences are ignored
    }

    // Don't handle other things
};

XMPPConnector.prototype.joinRoom = function (room) {
    console.log('XMPP joining', room);

    var presence = new ltx.Element('presence', {
        to : room + '@' + this.bot.config.xmpp_conference_host + '/' + this.bot.config.xmpp_resource
    });
    presence.c('x', { xmlns : 'http://jabber.org/protocol/muc' });

    this.client.send(presence);
    this.events.emit('joinedRoom', room);
};

XMPPConnector.prototype.leaveRoom = function (room) {
    console.log('XMPP leaving', room);

    var presence = new ltx.Element('presence', {
        to : room + '@' + this.bot.config.xmpp_conference_host + '/' + this.bot.config.xmpp_resource,
        type : 'unavailable'
    });

    this.client.send(presence);
    this.events.emit('leftRoom', room);
};

XMPPConnector.prototype.parseChat = function (stanza) {
    var route, user = null, room = null,
        body = stanza.getChildText('body');

    // Don't accept empty messages
    if (!body) {
        return;
    }

    // Don't accept old messages - if the bot is down, it's down.
    if (stanza.getChild('delay')) {
        return;
    }

    if (stanza.attrs.type === 'groupchat') {
        // Extract user + room from stanza
        var name = stanza.attrs.from.split('/')[1];
        user = this.user_nicks[name];
        room = stanza.attrs.from.split('@')[0];

        // Never pay any attention to our own messages.
        if (user === this.bot.config.xmpp_user || user === this.bot.config.xmpp_resource) {
            return;
        }

    } else {
        // Some providers (slack, for instance) send recently sent direct messages in a weird way upon reconnection.
        // They appear with bodies like this: "[fritbot] Huh?" but as if they were sent by the other user in the conversation.
        if (body.indexOf('[' + this.bot.config.xmpp_user + ']') === 0) {
            return;
        }

        // Direct messages parse differently
        user = stanza.attrs.from.split('@')[0];
    }

    route = new this.Route(this, room, user);

    if (body) {
        this.events.emit('sawMessage', route, stanza.getChildText('body'));
    }
};

XMPPConnector.prototype.send = function (route, message) {
    if (route.room && route.user) {
        message = route.user.nick + ': ' + message;
    }
    var reply = new ltx.Element('message', {
        to : route.room ? route.room + '@' + this.bot.config.xmpp_conference_host : route.username + '@' + this.bot.config.xmpp_host,
        type : route.room ? 'groupchat' : 'chat'
    });
    reply.c('body').t(message);
    console.log(JSON.stringify(reply, null, 2))
    this.client.send(reply);
    this.events.emit('sentMessage', route, message);
};

XMPPConnector.prototype.shutdown = function () {
    if (this.keepAlive) {
        clearInterval(this.keepAlive);
    }
    this.client.end();
};

module.exports = XMPPConnector;
