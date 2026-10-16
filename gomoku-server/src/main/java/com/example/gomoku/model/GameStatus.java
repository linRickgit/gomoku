package com.example.gomoku.model;

/** 房间生命周期状态 */
public enum GameStatus {
    /** 房主已创建房间，等待对手加入 */
    WAITING,
    /** 双方就位，对局进行中 */
    PLAYING,
    /** 对局已结束（分出胜负 / 和棋 / 认输 / 对手掉线） */
    FINISHED
}
