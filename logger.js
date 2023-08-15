import { createLogger, format, transports } from "winston";

export const logger = createLogger({
    level: 'debug',
    format: format.combine(
        format.splat(),
        format.simple()
      ),
    transports: [
        new transports.File({ filename: 'logs/error.log', level: 'warn' }),
        new transports.Console()
    ],
});
export const resultLogger = createLogger({
    level: 'info',
    format: format.combine(
        format.splat(),
        format.simple()
      ),
    transports: [
        new transports.File({ filename: 'logs/result.log' }),
    ],
});