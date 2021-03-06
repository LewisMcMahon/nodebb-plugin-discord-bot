"use strict";
var DiscordClient = require("discord.io");
var winston = module.parent.require("winston");
var db = module.parent.require("./database");
var Posts = module.parent.require("./posts");
var Topics = module.parent.require("./topics");
var User = module.parent.require("./user");
var plugins = module.parent.require("./plugins");
var Package = require("./package.json");
var siteConfig = module.parent.require("../config.json");

var bot = {};
var adminRoute = "/admin/plugins/discord-bot";
var settings = {
	"botEmail": process.env.DISCORD_BOT_EMAIL || undefined,
	"botPassword": process.env.DISCORD_BOT_PASSWORD || undefined,
	"botUpdateChannel": process.env.DISCORD_BOT_CHANNEL || undefined,
	"welcomeMessage" : undefined
};

var membersToWelcome = [];
var NodebbBot = {};

//should return a list of repplies as the second callback argument and an error only if their is an error as the first callback arguemnt
function getReplies(command,fromDiscordUser,fromDiscordUserID,callback) {
	var replies = [];

	if (command == "hello" || command == "hi"){
		replies.push("<@"+fromDiscordUserID+"> hello ");
	}

	if (command == "help"){
		var helpMessage = "<@"+fromDiscordUserID+">";

		//helpMessage is a string you should append the help message for your plugin to it
		plugins.fireHook("filter:nodebbbot.helpmessage", {helpMessage: helpMessage});

		replies.push(helpMessage);
	}

	//replys is a list you should just push a repply onto the list the bot will say each reply separately in the order they are
	plugins.fireHook("filter:nodebbbot.command.reply", {command : command ,replies: replies,fromDiscordUser:fromDiscordUser,fromDiscordUserID:fromDiscordUserID});

	return callback(null,replies);

}

function nodebbBotSettings(req, res, next) {
	var data = req.body;
	var newSettings = {
		botEmail: data.botEmail || "",
		botPassword: data.botPassword || "",
		botUpdateChannel: data.botUpdateChannel || "",
		welcomeMessage: data.welcomeMessage || ""
	};

	saveSettings(newSettings, res, next);
}

function fetchSettings(callback){
	db.getObjectFields(Package.name, Object.keys(settings), function(err, newSettings){
		if (err) {
			winston.error(err.message);
			if (typeof callback === "function") {
				callback(err);
			}
			return;
		}

		if(!newSettings.botEmail){
			settings.botEmail = process.env.DISCORD_BOT_EMAIL || "";
		}else{
			settings.botEmail = newSettings.botEmail;
		}

		if(!newSettings.botPassword){
			settings.botPassword = process.env.DISCORD_BOT_PASSWORD || "";
		}else{
			settings.botPassword = newSettings.botPassword;
		}

		if(!newSettings.botUpdateChannel){
			settings.botUpdateChannel = process.env.DISCORD_BOT_CHANNEL || "";
		}else{
			settings.botUpdateChannel = newSettings.botUpdateChannel;
		}

		if(!newSettings.welcomeMessage){
			settings.welcomeMessage = "";
		}else{
			settings.welcomeMessage = newSettings.welcomeMessage;
		}

		if (typeof callback === "function") {
			callback();
		}
	});
}

function saveSettings(settings, res, next) {
	db.setObject(Package.name, settings, function(err) {
		if (err) {

			return next(winston.error(err.message));
		}

		fetchSettings(function () {
		});
		res.json("Saved!");
	});
}

function renderAdmin(req, res) {
	// Regenerate csrf token
	var token = req.csrfToken();

	var data = {
		botEmail: settings.botEmail,
		botPassword: settings.botPassword,
		botUpdateChannel: settings.botUpdateChannel,
		welcomeMessage: settings.welcomeMessage,
		csrf: token
	};

	res.render("admin/plugins/discord-bot", data);
}

NodebbBot.load = function(params, callback) {

	fetchSettings(function(err,data) {
		if (err) {
			return winston.error(err.message);
		}

		params.router.get(adminRoute, params.middleware.applyCSRF, params.middleware.admin.buildHeader, renderAdmin);
		params.router.get("/api" + adminRoute, params.middleware.applyCSRF, renderAdmin);
		params.router.post("/api" + adminRoute + "/nodebbBotSettings", nodebbBotSettings);

		if (typeof settings.botEmail == undefined){
			winston.error("botEmail undefined");
			return callback(new Error("botEmail undefined"),null);
		}
		if (typeof settings.botPassword == undefined){
			winston.error("botPassword undefined");
			return callback(new Error("botPassword undefined"),null);
		}
		if (typeof settings.botUpdateChannel == undefined){
			winston.error("botUpdateChannel undefined");
			return callback(new Error("botUpdateChannel undefined"),null)
		}


		bot = new DiscordClient({
			autorun: true,
			email: settings.botEmail,
			password: settings.botPassword
		});

		bot.on("ready", function() {
			bot.on("message", function(user, userID, channelID, message, rawEvent) {
				//if message is directed at the bot
				if(message.startsWith("<@"+bot["id"]+">")){
					var command = message.replace("<@"+bot["id"]+">","").trim().toLowerCase();
					getReplies(command,user,userID,function (err,data) {
						data.forEach(function(entry){
							sendMessage(entry,channelID,function (err,data) {
								return callback(null,data);
							});
						});
					});
				}
			});
		});

		bot.on("debug", function(rawEvent) {
			if (rawEvent.t == "GUILD_MEMBER_ADD"){
				var discordUsername = rawEvent.d["user"]["username"].toString();
				var discordUserID = rawEvent.d["user"]["id"].toString();
				//have to wait untill the member is online to send the welcome message
				membersToWelcome.push(discordUserID);
				plugins.fireHook("static:nodebbbot.newmemberjoined", {discordUsername : discordUsername, discordUserID : discordUserID},function (err) {});

			}else if (rawEvent.t == "PRESENCE_UPDATE"){

				var discordUserID = rawEvent.d["user"]["id"].toString();
				//if it was a member we need to welcome
				if ( membersToWelcome.indexOf(discordUserID) >= 0){

					//send the welcome message
					var discordUsername = rawEvent.d["user"]["username"].toString();
					var welcomeMessage = settings.welcomeMessage || "";
					plugins.fireHook("filter:nodebbbot.welcome.message", {discordUsername : discordUsername, discordUserID : discordUserID, welcomeMessage : welcomeMessage});
					sendMessage(welcomeMessage,discordUserID,function (err,data) {
						if(err){
							winston.error("[NodeBB Bot] encountered a problem while sending the welcome message", err.message);
						}else{
							//remove the user from the to welcome list
							for (var i=membersToWelcome.length-1; i>=0; i--) {
								if (membersToWelcome[i] === discordUserID) {
									membersToWelcome.splice(i, 1);
									break;
								}
							}
						}
					});
				}
			}
		});

		return callback(null,data);

	});
};

function getPostURl(pid,tid,callback){
	Topics.getTopicField(tid,"slug",function (err,slug) {
		var url = siteConfig.url+"/topic/"+slug+"/"+pid;
		return callback(err,url);
	});

}

function getDiscordUserName(uid,callback){
	User.getUsernamesByUids([uid],function (err,userName) {
		callback(null,userName[0]);
	});
}

function stringAbbreviate(str, max, suffix)
{
	if((str = str.replace(/^\s+|\s+$/g, "").replace(/[\r\n]*\s*[\r\n]+/g, " ").replace(/[ \t]+/g, " ")).length <= max)
	{
		return str;
	}
	var
		abbr = "",
		str = str.split(" "),
		suffix = (typeof suffix !== "undefined" ? suffix : " ..."),
		max = (max - suffix.length);

	for(var len = str.length, i = 0; i < len; i ++)
	{
		if((abbr + str[i]).length < max)
		{
			abbr += str[i] + " ";
		}
		else { break; }
	}
	return abbr.replace(/[ ]$/g, "") + suffix;
}

function sendMessage(message,channel,callback){
	bot.sendMessage({
		to: channel,
		message: message
	},function (err,data) {
		if (err){
			winston.error("[NodeBB Bot] encountered a problem while sending a message", err.message);
			return callback(err,null);
		}
		else{
			console.log(data);
			return callback(null,data);
		}
	});
}

NodebbBot.userPosted = function (postData,callback) {
	console.log(postData);
	getPostURl(postData["pid"],postData["tid"],function (err,postURL) {
		if (err){
			winston.error("[NodeBB Bot] encountered a problem while getting the post url", err.message);
		}
		getDiscordUserName(postData["uid"],function (err,userName) {
			if (err){
				winston.error("[NodeBB Bot] encountered a problem while getting the discord Username", err.message);
			}
			var postContent = stringAbbreviate(postData["content"],100,"...");

			var message = "";
			message = "User "+userName+" has posted \n\n";
			message = message+postContent+"\n\n";
			message = message+postURL;
			sendMessage(message,settings.botUpdateChannel,function (err,messageData) {

				return callback(null,postData);
			});
		});
	});
};

NodebbBot.adminMenu = function(custom_header, callback) {
	custom_header.plugins.push({
		"route": "/plugins/discord-bot",
		"icon": "fa-envelope-o",
		"name": "Discord Bot"
	});

	callback(null, custom_header);
};

module.exports = NodebbBot;