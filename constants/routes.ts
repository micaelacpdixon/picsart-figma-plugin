import commands from "./commands";
import controllersIndex from "@controllers/index" 

const ROUTES = {
    [commands.COMMAND_AGENTS] : controllersIndex.AgentsController,
    [commands.COMMAND_REMOVEBACKGROUND] : controllersIndex.RemoveBackgroundController,
    [commands.COMMAND_UPSCALE]          : controllersIndex.EnhanceController,
    [commands.COMMAND_ACCOUNT]          : controllersIndex.AccountController, 
    [commands.COMMAND_SUPPORT]          : controllersIndex.SupportController,
    [commands.COMMAND_GENERATE_IMAGE]   : controllersIndex.GenerateImageController, 
}

export default ROUTES;