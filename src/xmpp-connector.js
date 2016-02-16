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

    bot.configLoader.ensure('xmpp_host', null, 'XMPP Server Hostname (blah.slack.com)');
    bot.configLoader.ensure('xmpp_conference_host', null, "Usually prepend 'conference.' to server hostname (conference.blah.slack.com)");
    bot.configLoader.ensure('xmpp_user', null, 'Bot Username');
    bot.configLoader.ensure('xmpp_resource', null, 'Resource - for some services, such as Slack, this must be the same as user');
    bot.configLoader.ensure('xmpp_password', null, null);
    bot.configLoader.ensure('xmpp_presence', 'The Angriest Bot', 'Bot status line');
    bot.configLoader.ensure('xmpp_rooms', [], 'List of rooms to join');

    // Create XMPP client
    self.client = new Client({
        jid : bot.config.xmpp_user + '@' + bot.config.xmpp_host + '/' + bot.config.xmpp_resource,
        password : bot.config.xmpp_password,
        host : bot.config.xmpp_host,
        reconnect : true
    });

    // Handle whenever we get a XML stanza from the server
    self.client.on('stanza', function (stanza) {
        // Handle inbound messages
        if (stanza.is('message')) {
            if (stanza.attrs.type === 'chat' || stanza.attrs.type === 'groupchat') {
                self.parseChat(stanza);
            }
        }

        // Handle pings
        if (stanza.is('iq') && stanza.attrs.type === 'get' && stanza.children[0].name === 'ping') {
            var pong = new ltx.Element('iq', {
                to : stanza.attrs.from,
                from : stanza.attrs.to,
                type : 'result',
                id : stanza.attrs.id
            });
            self.client.send(pong);
        }

        // Handle inbound room presence
        if (stanza.is('presence') && stanza.getChild('x') && stanza.getChild('x').attrs.xmlns.indexOf('muc') > -1)  {
            var user = stanza.attrs.from.split('/')[1];
            var room = stanza.attrs.from.split('@')[0];

            if (room && user && stanza.attrs.to !== bot.config.xmpp_user + '@' + bot.config.xmpp_host) {
                var route = new self.Route(self, room, user);
                if (stanza.attrs.type === 'unavailable') {
                    bot.users.userLeavesRoom(route);
                } else {
                    bot.users.userEntersRoom(route);
                }
            }
        }

        // Don't handle other things
    });

    // We've connected to the server
    self.client.on('online', function () {
        console.log('XMPP is online');
        self.events.emit('chat_connected', self);
        self.client.send(new ltx.Element('presence', { })
          .c('show').t('chat').up()
          .c('status').t(bot.config.xmpp_presence)
            .c('c', {
                xmlns: "http://jabber.org/protocol/caps",
                node: "http://hipchat.com/client/bot"})
        );

        for (var i in bot.config.xmpp_rooms) {
            self.joinRoom(bot.config.xmpp_rooms[i]);
        }
    });

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

XMPPConnector.prototype.joinRoom = function (room) {
    console.log('XMPP joining', room);
    var presence = new ltx.Element('presence', {
        to : room + '@' + this.bot.config.xmpp_conference_host + '/' + this.bot.config.xmpp_resource
    });
    presence.c('x', { xmlns : 'http://jabber.org/protocol/muc' })
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
        user = stanza.attrs.from.split('/')[1];
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
    this.client.send(reply);
    this.events.emit('sentMessage', route, message);
};

XMPPConnector.prototype.shutdown = function () {
    this.client.end();
};

module.exports = XMPPConnector;
