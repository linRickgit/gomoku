package com.example.gomoku.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * 允许前端与后端跨源部署：前端可以托管在与后端不同主机/端口的静态服务器上，
 * 通过 {@code VITE_API_BASE} 指向后端的地址（例如 http://192.168.1.120:9000）。
 * 浏览器对跨源 fetch 会做 CORS 校验，这里放开 /api 接口的源限制。
 * <p>
 * 仅放开 /api 下的 REST 接口；WebSocket 的源校验在 {@link WebSocketConfig} 中单独放开。
 */
@Configuration
public class CorsConfig {

    @Bean
    public WebMvcConfigurer corsConfigurer() {
        return new WebMvcConfigurer() {
            @Override
            public void addCorsMappings(CorsRegistry registry) {
                registry.addMapping("/api/**")
                        .allowedOriginPatterns("*")
                        .allowedMethods("GET", "POST", "OPTIONS")
                        .allowedHeaders("*")
                        .allowCredentials(false);
            }
        };
    }
}
