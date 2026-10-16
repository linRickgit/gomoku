package com.example.gomoku.exception;

/** 业务异常：房间不存在、房间已满等可预期错误 */
public class BizException extends RuntimeException {

    private final String errorCode;

    public BizException(String errorCode, String message) {
        super(message);
        this.errorCode = errorCode;
    }

    public String errorCode() {
        return errorCode;
    }
}
