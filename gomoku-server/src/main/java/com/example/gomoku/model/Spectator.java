package com.example.gomoku.model;

/**
 * 观战者。房间满员后仍可用房间码进入，只能看棋，不能落子。
 */
public class Spectator {

    private final String nickname;
    private final String token;

    public Spectator(String nickname, String token) {
        this.nickname = nickname;
        this.token = token;
    }

    public String nickname() {
        return nickname;
    }

    public String token() {
        return token;
    }
}
