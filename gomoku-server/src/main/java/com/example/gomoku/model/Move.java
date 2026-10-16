package com.example.gomoku.model;

/** 一步落子记录 */
public record Move(int seat, int row, int col, int index) {
}
